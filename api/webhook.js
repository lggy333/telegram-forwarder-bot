const BOT_TOKEN = process.env.BOT_TOKEN; 
const CHANNEL_ID_ENV = process.env.CHANNEL_ID; 
const ALLOWED_CHANNELS = CHANNEL_ID_ENV ? CHANNEL_ID_ENV.split(',').map(id => id.trim()).filter(Boolean) : [];
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID || process.env.ADMIN_USER_ID;
const UPSTASH_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------
// 性能监控全局状态 & 并发/计数追踪
// ---------------------------------------------------------
let isInstanceCold = true; // 实例首次加载标记
let activeInFlightCount = 0; // 当前实例正在并发处理的请求数
let instanceMessageCounter = 0; // 暖实例累积处理成功的消息序号 (新增)

const perfStats = {
  count: 0,
  redisMsSum: 0,
  copyMsSum: 0,
  deleteMsSum: 0,
  totalMsSum: 0,
  rateLimitCount: 0
};

// ---------------------------------------------------------
// 核心网络请求封装
// ---------------------------------------------------------
async function telegramFetch(url, options, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    options.signal = controller.signal;
    const response = await fetch(url, options);
    clearTimeout(timeoutId);

    const data = await response.json().catch(() => null);

    if (response.status === 429) {
      const retryAfter = data?.parameters?.retry_after || 1;
      return { ok: false, isRateLimit: true, retryAfter };
    }
    if (!response.ok) return { ok: false, httpStatus: response.status, data };
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, isTimeout: err.name === 'AbortError', error: err };
  }
}

// ---------------------------------------------------------
// Redis 操作封装
// ---------------------------------------------------------
async function redisCmd(command, ...args) {
  if (!UPSTASH_REST_URL || !UPSTASH_REST_TOKEN) return { ok: false, error: '未配置 Redis' };
  try {
    const endpoint = [command, ...args].map(a => encodeURIComponent(a)).join('/');
    const res = await fetch(`${UPSTASH_REST_URL}/${endpoint}`, {
      headers: { Authorization: `Bearer ${UPSTASH_REST_TOKEN}` }
    });
    const data = await res.json();
    if (res.status !== 200 || data.error) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, result: data.result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getBotSettings() {
  const dedupRes = await redisCmd('get', 'config:dedup_enabled');
  const backupRes = await redisCmd('get', 'config:backup_enabled');
  return {
    dedupEnabled: dedupRes.result !== '0',   
    backupEnabled: backupRes.result !== '0'  
  };
}

let cachedSettings = null;
let cachedSettingsTime = 0;
async function getBotSettingsCached() {
  const now = Date.now();
  if (cachedSettings && (now - cachedSettingsTime < 15000)) { 
    return cachedSettings;
  }
  cachedSettings = await getBotSettings();
  cachedSettingsTime = now;
  return cachedSettings;
}

// ---------------------------------------------------------
// 频道信息与管理相关逻辑
// ---------------------------------------------------------
async function getChannelsInfo() {
  const list = [];
  for (const id of ALLOWED_CHANNELS) {
    const res = await telegramFetch(`${TELEGRAM_API}/getChat`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: id })
    });
    if (res.ok && res.data?.ok) {
      list.push({ id, title: res.data.result.title || id });
    } else {
      list.push({ id, title: `未命名频道 (${id})` });
    }
  }
  return list;
}

async function clearChannelKeys(channelId) {
  const pattern = channelId ? `file:${channelId}:*` : `file:*`;
  const keysRes = await redisCmd('keys', pattern);
  if (!keysRes.ok || !Array.isArray(keysRes.result) || keysRes.result.length === 0) {
    return { ok: true, count: 0 };
  }

  const keys = keysRes.result;
  const pipelineBody = keys.map(k => ["DEL", k]);
  
  try {
    await fetch(`${UPSTASH_REST_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipelineBody)
    });
    return { ok: true, count: keys.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getChannelKeyCount(channelId) {
  const pattern = channelId ? `file:${channelId}:*` : `file:*`;
  const keysRes = await redisCmd('keys', pattern);
  return keysRes.ok && Array.isArray(keysRes.result) ? keysRes.result.length : 0;
}

async function buildMainMenu() {
  const settings = await getBotSettingsCached();
  const text = `🤖 **控制面板**\n\n点击下方按钮即可进行管理操作：`;

  const keyboard = {
    inline_keyboard: [
      [{ text: "📢 选择频道管理记忆", callback_data: "select_channel" }],
      [
        { text: `去重功能: ${settings.dedupEnabled ? '✅ 开启中' : '❌ 已暂停'}`, callback_data: "toggle_dedup" },
        { text: `私发备份: ${settings.backupEnabled ? '✅ 开启中' : '❌ 已关闭'}`, callback_data: "toggle_backup" }
      ],
      [
        { text: "🩺 一键系统自检", callback_data: "system_health" },
        { text: "🗑️ 清空所有记录", callback_data: "confirm_clean_all" }
      ]
    ]
  };
  return { text, reply_markup: keyboard };
}

// ---------------------------------------------------------
// 带 Trace 细节记录的 copyMessage 重试逻辑
// ---------------------------------------------------------
async function copyMessageWithRetry(chatId, fromChatId, messageId, trace, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const tStart = performance.now();
    const res = await telegramFetch(`${TELEGRAM_API}/copyMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, from_chat_id: fromChatId, message_id: messageId })
    });
    const attemptMs = (performance.now() - tStart).toFixed(1);

    if (res.ok && res.data?.ok) {
      instanceMessageCounter++; // 累积全局成功计次
      trace.msgIndex = instanceMessageCounter; // 标记本次是第几条
      trace.copyAttempts.push({ 
        attempt: i + 1, 
        status: `成功 (200 OK) [实例第 ${instanceMessageCounter} 条]`, 
        ms: attemptMs 
      });
      return { success: true };
    }

    if (res.isRateLimit) {
      perfStats.rateLimitCount++;
      const waitMs = (res.retryAfter * 1000) + 200;
      trace.copyAttempts.push({ 
        attempt: i + 1, 
        status: `⚠️ 429 限流 ( Telegram 强制要求等待 ${res.retryAfter}s )`, 
        ms: attemptMs 
      });
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    const waitMs = 500 * Math.pow(2, i);
    trace.copyAttempts.push({ 
      attempt: i + 1, 
      status: `❌ 失败 HTTP ${res.httpStatus || 'Timeout'} (退避等待 ${waitMs}ms)`, 
      ms: attemptMs 
    });
    await new Promise(r => setTimeout(r, waitMs));
  }
  
  return { success: false };
}

// ---------------------------------------------------------
// 打印日志格式化工具 (新增 MsgIndex 与 FileSize 观察点)
// ---------------------------------------------------------
function printTraceLog(trace, reqStartMs) {
  const totalMs = (performance.now() - reqStartMs).toFixed(1);
  
  perfStats.count++;
  perfStats.redisMsSum += parseFloat(trace.redisMs || 0);
  perfStats.copyMsSum += parseFloat(trace.copyTotalMs || 0);
  perfStats.deleteMsSum += parseFloat(trace.deleteMs || 0);
  perfStats.totalMsSum += parseFloat(totalMs);

  let attemptsDetail = trace.copyAttempts.map(a => 
    `   └─ 第 ${a.attempt} 次尝试: ${a.status} -> TG响应耗时: ${a.ms}ms`
  ).join('\n');

  console.log(`
==================================================
📊 [Trace] 序号: #${trace.msgIndex || 'Duplicates'} | MessageID: ${trace.messageId} | UniqueID: ${trace.uniqueId || 'None'}
📦 媒体类型: ${trace.mediaType} | 文件大小: ${trace.fileSizeFormatted}
⏰ 收到请求: ${trace.timestamp} | 🧊 容器: ${trace.isCold ? '❄️ 冷启动' : '🔥 暖实例'} | ⚡ 实例并发: ${trace.activeInFlight}
--------------------------------------------------
💾 Redis 去重耗时:    ${trace.redisMs || 0} ms
📤 CopyMessage 总耗时: ${trace.copyTotalMs || 0} ms
${attemptsDetail ? attemptsDetail + '\n' : ''}🗑️ DeleteMessage 耗时: ${trace.deleteMs || 0} ms
--------------------------------------------------
⏱️ Webhook 处理总耗时: ${totalMs} ms
==================================================`);

  if (perfStats.count % 10 === 0) {
    console.log(`
📈 [统计] 当前容器累积处理 ${perfStats.count} 条消息均值报告：
• Redis   平均耗时: ${(perfStats.redisMsSum / perfStats.count).toFixed(1)} ms
• Copy    平均耗时: ${(perfStats.copyMsSum / perfStats.count).toFixed(1)} ms
• Delete  平均耗时: ${(perfStats.deleteMsSum / perfStats.count).toFixed(1)} ms
• 全流程  平均耗时: ${(perfStats.totalMsSum / perfStats.count).toFixed(1)} ms
• 触发 429 累计次数: ${perfStats.rateLimitCount} 次
--------------------------------------------------`);
  }
}

// ---------------------------------------------------------
// 路由主入口
// ---------------------------------------------------------
export default async function handler(req, res) {
  const reqStartMs = performance.now();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const body = req.body || {};

  activeInFlightCount++;

  const currentReqIsCold = isInstanceCold;
  if (isInstanceCold) isInstanceCold = false;

  const trace = {
    msgIndex: null,
    messageId: 'Unknown',
    uniqueId: null,
    mediaType: 'Unknown',
    fileSizeFormatted: 'N/A',
    timestamp: new Date().toISOString().split('T')[1].slice(0, 12),
    isCold: currentReqIsCold,
    activeInFlight: activeInFlightCount,
    redisMs: 0,
    copyTotalMs: 0,
    deleteMs: 0,
    copyAttempts: []
  };

  try {
    // =========================================================
    // 处理 1：点击交互按钮 (Callback Query)
    // =========================================================
    if (body.callback_query) {
      const cb = body.callback_query;
      const userId = String(cb.from.id);
      const cbId = cb.id;
      const chatId = cb.message.chat.id;
      const msgId = cb.message.message_id;

      if (ADMIN_USER_ID && userId !== String(ADMIN_USER_ID)) {
        await telegramFetch(`${TELEGRAM_API}/answerCallbackQuery`, {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ callback_query_id: cbId, text: '⛔ 仅管理员可操作！', show_alert: true })
        });
        return res.status(200).send('OK');
      }

      const action = cb.data;

      if (action === 'menu_main') {
        const menu = await buildMainMenu();
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup })
        });
      }
      else if (action === 'select_channel') {
        const channels = await getChannelsInfo();
        const buttons = channels.map(c => ([{ text: `📢 ${c.title}`, callback_data: `view_chan_${c.id}` }]));
        buttons.push([{ text: "⬅️ 返回主菜单", callback_data: "menu_main" }]);
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: `📢 **请点击要管理的频道名字：**`, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } })
        });
      }
      else if (action.startsWith('view_chan_')) {
        const chanId = action.replace('view_chan_', '');
        const count = await getChannelKeyCount(chanId);
        const resChan = await telegramFetch(`${TELEGRAM_API}/getChat`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chanId }) });
        const title = resChan.ok ? resChan.data.result.title : chanId;

        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({
            chat_id: chatId, message_id: msgId, text: `📌 **频道名称：** \`${title}\`\n🆔 **频道 ID：** \`${chanId}\`\n💾 **已记录去重文件数：** \`${count}\` 个\n\n你可以点击下方按钮清空该频道的记忆，以便重新发送过往文件：`,
            parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: `🗑️ 清空「${title}」的去重记忆`, callback_data: `clean_chan_${chanId}` }], [{ text: "⬅️ 返回频道列表", callback_data: "select_channel" }]] }
          })
        });
      }
      else if (action.startsWith('clean_chan_')) {
        const chanId = action.replace('clean_chan_', '');
        const resClean = await clearChannelKeys(chanId);
        const msgText = resClean.ok ? `✅ **清理完成！**\n已清空该频道 \`${resClean.count}\` 条文件记忆。` : `❌ 清理失败：${resClean.error}`;
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: msgText, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回频道列表", callback_data: "select_channel" }]] } })
        });
      }
      else if (action === 'toggle_dedup') {
        const settings = await getBotSettingsCached();
        await redisCmd('set', 'config:dedup_enabled', settings.dedupEnabled ? '0' : '1');
        cachedSettings = null; 
        const menu = await buildMainMenu();
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup }) });
      }
      else if (action === 'toggle_backup') {
        const settings = await getBotSettingsCached();
        await redisCmd('set', 'config:backup_enabled', settings.backupEnabled ? '0' : '1');
        cachedSettings = null; 
        const menu = await buildMainMenu();
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup }) });
      }
      else if (action === 'confirm_clean_all') {
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({
            chat_id: chatId, message_id: msgId, text: `⚠️ **高危操作确认**\n\n确定要清空**所有频道**的去重记忆吗？`, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "🔥 确认彻底清空", callback_data: "do_clean_all" }, { text: "❌ 取消", callback_data: "menu_main" }]] }
          })
        });
      }
      else if (action === 'do_clean_all') {
        const resClean = await clearChannelKeys(null);
        const msgText = resClean.ok ? `✅ **全局清理成功！** 共清除 \`${resClean.count}\` 条数据库记录。` : `❌ 清理失败：${resClean.error}`;
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: msgText, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回主菜单", callback_data: "menu_main" }]] } })
        });
      }
      else if (action === 'system_health') {
        let report = `🩺 **系统健康自检报告**\n\n`;
        const startT = Date.now();
        const pingRes = await redisCmd('ping');
        const delay = Date.now() - startT;
        report += `💾 **Redis 数据库：** ${pingRes.ok ? `✅ 正常 (${delay}ms)` : `❌ 异常 (${pingRes.error})`}\n\n📢 **频道管理员权限检测：**\n`;
        
        const channels = await getChannelsInfo();
        for (const c of channels) {
          const memberRes = await telegramFetch(`${TELEGRAM_API}/getChatMember`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: c.id, user_id: BOT_TOKEN.split(':')[0] }) });
          if (memberRes.ok && memberRes.data?.result?.status === 'administrator') {
            const adm = memberRes.data.result;
            report += `• **${c.title}**\n  - 发帖: ${adm.can_post_messages ? '✅' : '❌无发帖权限'} | 删帖: ${adm.can_delete_messages ? '✅' : '❌无删除权限'}\n`;
          } else {
            report += `• **${c.title}**\n  - ❌ 机器人未获取到管理员身份\n`;
          }
        }
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: report, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回主菜单", callback_data: "menu_main" }]] } })
        });
      }

      await telegramFetch(`${TELEGRAM_API}/answerCallbackQuery`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ callback_query_id: cbId }) });
      return res.status(200).send('OK');
    }

    // =========================================================
    // 处理 2：常规频道/私聊消息
    // =========================================================
    const message = body.channel_post || body.message;
    if (!message) return res.status(200).send('OK');
    if (!BOT_TOKEN || ALLOWED_CHANNELS.length === 0) return res.status(200).send('OK - Config Missing');

    const currentChatId = String(message.chat.id);
    const isPrivate = message.chat.type === 'private';
    const userId = String(message.from?.id || '');

    // 2.1 私聊触发主菜单
    if (isPrivate) {
      if (ADMIN_USER_ID && userId !== String(ADMIN_USER_ID)) return res.status(200).send('OK - Unauthorized');
      const menu = await buildMainMenu();
      await telegramFetch(`${TELEGRAM_API}/sendMessage`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: currentChatId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup }) });
      return res.status(200).send('OK');
    }

    // 2.2 频道处理逻辑
    if (!ALLOWED_CHANNELS.includes(currentChatId)) return res.status(200).send('OK');
    if (message.author_signature === 'Bot' || message.from?.is_bot) return res.status(200).send('OK');

    const video = message.video;
    const photo = message.photo;
    const animation = message.animation;
    const document = message.document;

    if (!video && !photo && !animation && !document) return res.status(200).send('OK - Ignored Text');

    const messageId = message.message_id;
    trace.messageId = messageId;

    // 提取 UniqueID 与计算 FileSize
    let uniqueId = null;
    let rawSizeBytes = 0;

    if (video) {
      uniqueId = video.file_unique_id;
      rawSizeBytes = video.file_size || 0;
      trace.mediaType = 'Video';
    } else if (photo) {
      const targetPhoto = photo[photo.length - 1];
      uniqueId = targetPhoto.file_unique_id;
      rawSizeBytes = targetPhoto.file_size || 0;
      trace.mediaType = 'Photo';
    } else if (animation) {
      uniqueId = animation.file_unique_id;
      rawSizeBytes = animation.file_size || 0;
      trace.mediaType = 'Animation';
    } else if (document) {
      uniqueId = document.file_unique_id;
      rawSizeBytes = document.file_size || 0;
      trace.mediaType = 'Document';
    }

    trace.uniqueId = uniqueId;
    trace.fileSizeFormatted = rawSizeBytes > 0 
      ? (rawSizeBytes > 1048576 ? `${(rawSizeBytes / 1048576).toFixed(2)} MB` : `${(rawSizeBytes / 1024).toFixed(1)} KB`)
      : 'Unknown';

    const settings = await getBotSettingsCached();

    // 2.3 Redis 去重判断
    if (uniqueId && settings.dedupEnabled) {
      const tRedisStart = performance.now();
      const redisKey = `file:${currentChatId}:${uniqueId}`;
      const setRes = await redisCmd('set', redisKey, '1', 'NX');
      trace.redisMs = (performance.now() - tRedisStart).toFixed(1);

      // 拦截重复文件
      if (setRes.ok && setRes.result !== 'OK') {
        try {
          if (settings.backupEnabled && ADMIN_USER_ID) {
            const copyRes = await telegramFetch(`${TELEGRAM_API}/copyMessage`, {
              method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: ADMIN_USER_ID, from_chat_id: currentChatId, message_id: messageId })
            });
            if (copyRes.ok) {
              await telegramFetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: ADMIN_USER_ID, text: `⚠️ **[自动去重备份]**\n已拦截频道 \`${currentChatId}\` 中的重复媒体！\n原重复消息已在上方备份 ⬆️`, parse_mode: 'Markdown' })
              });
            }
          }
        } finally {
          const tDelStart = performance.now();
          await telegramFetch(`${TELEGRAM_API}/deleteMessage`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: currentChatId, message_id: messageId }) });
          trace.deleteMs = (performance.now() - tDelStart).toFixed(1);
        }
        
        printTraceLog(trace, reqStartMs);
        return res.status(200).send('OK - Duplicate Cleaned');
      }
    }

    // 2.4 全新文件 copyMessage 复制去头流程
    const tCopyStart = performance.now();
    const copyProcess = await copyMessageWithRetry(currentChatId, currentChatId, messageId, trace);
    trace.copyTotalMs = (performance.now() - tCopyStart).toFixed(1);

    if (copyProcess.success) {
      const tDeleteStart = performance.now();
      await telegramFetch(`${TELEGRAM_API}/deleteMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: currentChatId, message_id: messageId })
      });
      trace.deleteMs = (performance.now() - tDeleteStart).toFixed(1);
    }

    printTraceLog(trace, reqStartMs);
    return res.status(200).send('OK');

  } finally {
    activeInFlightCount--;
  }
}
