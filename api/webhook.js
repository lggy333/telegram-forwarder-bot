const BOT_TOKEN = process.env.BOT_TOKEN; 
const CHANNEL_ID_ENV = process.env.CHANNEL_ID; 
const ALLOWED_CHANNELS = CHANNEL_ID_ENV ? CHANNEL_ID_ENV.split(',').map(id => id.trim()).filter(Boolean) : [];
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID || process.env.ADMIN_USER_ID;
const UPSTASH_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------
// 核心网络请求封装 (解析 429 和 retry_after)
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
// Redis 操作封装 (保持不变)
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
    dedupEnabled: dedupRes.result !== '0',   // 默认开启
    backupEnabled: backupRes.result !== '0'  // 默认开启
  };
}

// ---------------------------------------------------------
// 配置微缓存 (降低高并发下 Redis 读取压力)
// ---------------------------------------------------------
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
// 频道信息与管理相关逻辑 (保持不变)
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
// 核心重试复制逻辑 (生产环境安全保障)
// ---------------------------------------------------------
async function copyMessageWithRetry(chatId, fromChatId, messageId, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const res = await telegramFetch(`${TELEGRAM_API}/copyMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: chatId, from_chat_id: fromChatId, message_id: messageId })
    });

    // 复制成功，直接返回
    if (res.ok && res.data?.ok) {
      console.log(`[Copy OK] 消息 ${messageId} 复制成功`);
      return { success: true };
    }

    // 遇到 429 限流
    if (res.isRateLimit) {
      const waitMs = (res.retryAfter * 1000) + 200; // 额外加 200ms 缓冲
      console.log(`[429] 触发限流，等待 ${waitMs}ms 后重试 (第 ${i+1}/${maxRetries} 次)...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue; // 继续下一次尝试
    }

    // 其他未知错误或网络超时，使用指数退避 (500ms, 1000ms, 2000ms)
    const waitMs = 500 * Math.pow(2, i);
    console.log(`[Copy Failed] HTTP ${res.httpStatus || 'Timeout'}，等待 ${waitMs}ms 后重试 (第 ${i+1}/${maxRetries} 次)...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  
  console.log(`[Copy Error] 消息 ${messageId} 重试 ${maxRetries} 次后最终失败，放弃复制。`);
  return { success: false };
}

// ---------------------------------------------------------
// 路由主入口
// ---------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const body = req.body || {};

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
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ callback_query_id: cbId, text: '⛔ 仅管理员可操作！', show_alert: true })
      });
      return res.status(200).send('OK');
    }

    const action = cb.data;

    if (action === 'menu_main') {
      const menu = await buildMainMenu();
      await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup })
      });
    }
    else if (action === 'select_channel') {
      const channels = await getChannelsInfo();
      const buttons = channels.map(c => ([{ text: `📢 ${c.title}`, callback_data: `view_chan_${c.id}` }]));
      buttons.push([{ text: "⬅️ 返回主菜单", callback_data: "menu_main" }]);
      await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          chat_id: chatId, message_id: msgId, text: `📢 **请点击要管理的频道名字：**`, parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons }
        })
      });
    }
    else if (action.startsWith('view_chan_')) {
      const chanId = action.replace('view_chan_', '');
      const count = await getChannelKeyCount(chanId);
      const resChan = await telegramFetch(`${TELEGRAM_API}/getChat`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chanId }) });
      const title = resChan.ok ? resChan.data.result.title : chanId;

      await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          chat_id: chatId, message_id: msgId,
          text: `📌 **频道名称：** \`${title}\`\n🆔 **频道 ID：** \`${chanId}\`\n💾 **已记录去重文件数：** \`${count}\` 个\n\n你可以点击下方按钮清空该频道的记忆，以便重新发送过往文件：`,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: `🗑️ 清空「${title}」的去重记忆`, callback_data: `clean_chan_${chanId}` }], [{ text: "⬅️ 返回频道列表", callback_data: "select_channel" }]] }
        })
      });
    }
    else if (action.startsWith('clean_chan_')) {
      const chanId = action.replace('clean_chan_', '');
      const resClean = await clearChannelKeys(chanId);
      const msgText = resClean.ok ? `✅ **清理完成！**\n已清空该频道 \`${resClean.count}\` 条文件记忆。` : `❌ 清理失败：${resClean.error}`;
      await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({
          chat_id: chatId, message_id: msgId, text: msgText, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回频道列表", callback_data: "select_channel" }]] }
        })
      });
    }
    else if (action === 'toggle_dedup') {
      const settings = await getBotSettingsCached();
      await redisCmd('set', 'config:dedup_enabled', settings.dedupEnabled ? '0' : '1');
      cachedSettings = null; // 无效化缓存
      const menu = await buildMainMenu();
      await telegramFetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup }) });
    }
    else if (action === 'toggle_backup') {
      const settings = await getBotSettingsCached();
      await redisCmd('set', 'config:backup_enabled', settings.backupEnabled ? '0' : '1');
      cachedSettings = null; // 无效化缓存
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
  let uniqueId = null;
  if (video) uniqueId = video.file_unique_id;
  else if (photo) uniqueId = photo[photo.length - 1].file_unique_id;
  else if (animation) uniqueId = animation.file_unique_id;
  else if (document) uniqueId = document.file_unique_id;

  const settings = await getBotSettingsCached();

  // 2.3 去重判别
  if (uniqueId && settings.dedupEnabled) {
    const redisKey = `file:${currentChatId}:${uniqueId}`;
    const setRes = await redisCmd('set', redisKey, '1', 'NX');

    // 如果未返回 OK，说明已存在该文件 (重复文件拦截)
    if (setRes.ok && setRes.result !== 'OK') {
      console.log(`[Duplicate Found] 拦截到重复文件: ${uniqueId}`);
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
        // 重复文件直接无条件删除
        await telegramFetch(`${TELEGRAM_API}/deleteMessage`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ chat_id: currentChatId, message_id: messageId }) });
      }
      return res.status(200).send('OK - Duplicate Cleaned');
    }
  }

  // 2.4 全新文件无缝“复制”去头流程 (带有重试机制和成功校验)
  const copyProcess = await copyMessageWithRetry(currentChatId, currentChatId, messageId);

  // 【核心修复】：只有在复制确实成功的情况下，才删除原来的消息。
  if (copyProcess.success) {
    const deleteRes = await telegramFetch(`${TELEGRAM_API}/deleteMessage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: currentChatId, message_id: messageId })
    });
    console.log(`[Delete OK] 删除原消息 ${messageId}: ${deleteRes.ok ? '成功' : '失败'}`);
  } else {
    // 如果重试 3 次仍然遇到 429 或者其他崩溃，则跳过删除流程
    console.log(`[Delete Skip] 消息 ${messageId} 复制失败，跳过删除步骤，保护原文件不丢失。`);
  }

  return res.status(200).send('OK');
}
