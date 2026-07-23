const BOT_TOKEN = process.env.BOT_TOKEN; 
const CHANNEL_ID_ENV = process.env.CHANNEL_ID; 
const ALLOWED_CHANNELS = CHANNEL_ID_ENV ? CHANNEL_ID_ENV.split(',').map(id => id.trim()).filter(Boolean) : [];
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID || process.env.ADMIN_USER_ID;
const UPSTASH_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// ---------------------------------------------------------
// 1. 全局 Task 队列与 RateLimit 冷却器
// ---------------------------------------------------------
let nextAllowedCopyTime = 0;
let copyTaskQueue = Promise.resolve();

function enqueueTask(taskFn) {
  const result = copyTaskQueue.then(() => taskFn());
  copyTaskQueue = result.catch(() => {});
  return result;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------
// 2. Telegram API 请求封装
// ---------------------------------------------------------
async function telegramFetch(url, options, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const apiMethod = url.split('/').pop();

  try {
    options.signal = controller.signal;
    const response = await fetch(url, options);
    clearTimeout(timeoutId);

    const data = await response.json().catch(() => null);

    if (response.status === 429) {
      const retryAfter = data?.parameters?.retry_after || 5;
      console.warn(`🚨 [429 限流] ${apiMethod} | retry_after: ${retryAfter}s`);
      return { ok: false, isRateLimit: true, retryAfter, data };
    }

    if (!response.ok) {
      return { ok: false, httpStatus: response.status, data };
    }

    return { ok: true, data };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, isTimeout: err.name === 'AbortError', error: err };
  }
}

// ---------------------------------------------------------
// 3. Redis 操作封装
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

let cachedSettings = null;
let cachedSettingsTime = 0;
async function getBotSettingsCached() {
  const now = Date.now();
  if (cachedSettings && (now - cachedSettingsTime < 60000)) return cachedSettings;
  
  const dedupRes = await redisCmd('get', 'config:dedup_enabled');
  const backupRes = await redisCmd('get', 'config:backup_enabled');
  
  cachedSettings = {
    dedupEnabled: dedupRes.ok ? dedupRes.result !== '0' : true,
    backupEnabled: backupRes.ok ? backupRes.result !== '0' : true
  };
  cachedSettingsTime = now;
  return cachedSettings;
}

function clearSettingsCache() {
  cachedSettings = null;
}

async function clearChannelKeys(channelId) {
  const pattern = channelId ? `file:${channelId}:*` : `file:*`;
  let keysToDelete = [];

  const keysRes = await redisCmd('keys', pattern);
  if (keysRes.ok && Array.isArray(keysRes.result)) {
    keysToDelete = keysRes.result;
  }

  if (keysToDelete.length === 0) {
    let cursor = '0';
    do {
      const scanRes = await redisCmd('scan', cursor, 'MATCH', pattern, 'COUNT', '100');
      if (scanRes.ok && Array.isArray(scanRes.result)) {
        cursor = scanRes.result[0];
        const found = scanRes.result[1] || [];
        keysToDelete.push(...found);
      } else {
        break;
      }
    } while (cursor !== '0');
  }

  if (keysToDelete.length === 0) {
    return { ok: true, count: 0 };
  }

  const pipelineBody = keysToDelete.map(k => ["DEL", k]);
  try {
    await fetch(`${UPSTASH_REST_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipelineBody)
    });
    console.log(`[Redis 清理] 模式: ${pattern} | 成功清理 ${keysToDelete.length} 条记录`);
    return { ok: true, count: keysToDelete.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------
// 4. 管理后台界面构建
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

async function getChannelKeyCount(channelId) {
  const pattern = channelId ? `file:${channelId}:*` : `file:*`;
  const keysRes = await redisCmd('keys', pattern);
  return keysRes.ok && Array.isArray(keysRes.result) ? keysRes.result.length : 0;
}

async function buildMainMenu() {
  const settings = await getBotSettingsCached();
  const text = `🤖 **控制面板 (V5.1 稳定精简版)**\n\n` +
               `点击下方按钮进行去重与备份控制：`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "📢 选择频道管理记忆", callback_data: "select_channel" }
      ],
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
// 5. 核心逻辑工具函数
// ---------------------------------------------------------
function getMessageLink(chatId, messageId) {
  const strId = String(chatId);
  if (strId.startsWith('-100')) {
    return `https://t.me/c/${strId.replace('-100', '')}/${messageId}`;
  }
  return `https://t.me/${strId.replace('@', '')}/${messageId}`;
}

async function processDuplicateBackup(chatTitle, fromChatId, duplicateMsgId, originMsgId, meta) {
  if (!ADMIN_USER_ID) return;

  const targetMsgId = originMsgId || duplicateMsgId;
  const msgLink = getMessageLink(fromChatId, targetMsgId);
  
  let backupSuccess = false;
  let copyErrorDetail = '';

  const copyRes = await telegramFetch(`${TELEGRAM_API}/copyMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: ADMIN_USER_ID, from_chat_id: fromChatId, message_id: duplicateMsgId })
  });

  if (copyRes.ok && copyRes.data?.ok) {
    backupSuccess = true;
  } else {
    copyErrorDetail = copyRes.data?.description || `HTTP ${copyRes.httpStatus || '请求失败'}`;
    console.error(`❌ [备份到管理员失败] MsgID: ${duplicateMsgId} | 错误:`, copyRes);
  }

  const fileNameText = meta.fileName ? `\n📁 **文件：** \`${meta.fileName}\`` : '';
  const statusNotice = !backupSuccess ? `\n⚠️ *(备份副本失败: ${copyErrorDetail})*` : '';

  await telegramFetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      chat_id: ADMIN_USER_ID,
      text: `⚠️ **检测到重复文件并已清理**\n\n📢 **频道：** ${chatTitle}\n📦 **类型：** ${meta.mediaType}${fileNameText}\n📊 **大小：** ${meta.fileSizeFormatted}\n🆔 **重复消息ID：** \`${duplicateMsgId}\`${statusNotice}`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: `🔗 查看频道无头原消息 (#${targetMsgId})`, url: msgLink }]]
      }
    })
  });
}

async function executeCopyTaskWithRetry(chatId, fromChatId, messageId, maxRetries = 2) {
  return enqueueTask(async () => {
    for (let i = 0; i < maxRetries; i++) {
      const now = Date.now();
      if (now < nextAllowedCopyTime) {
        await sleep(nextAllowedCopyTime - now);
      }

      await sleep(350);

      const res = await telegramFetch(`${TELEGRAM_API}/copyMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: chatId, from_chat_id: fromChatId, message_id: messageId })
      });

      if (res.ok && res.data?.ok) {
        return { success: true, messageId: res.data.result.message_id };
      }

      if (res.isRateLimit) {
        nextAllowedCopyTime = Date.now() + (res.retryAfter * 1000) + 350;
        await sleep((res.retryAfter * 1000) + 350);
        continue;
      }

      await sleep(500 * Math.pow(2, i));
    }
    return { success: false };
  });
}

async function safeDeleteMessage(chatId, messageId) {
  await telegramFetch(`${TELEGRAM_API}/deleteMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: chatId, message_id: messageId })
  });
}

// ---------------------------------------------------------
// 6. Webhook 主流程入口
// ---------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const body = req.body || {};

  try {
    // =========================================================
    // 路由 1：处理管理员 Callback 交互
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
        const buttons = channels.map(c => ([
          { text: `📢 ${c.title}`, callback_data: `view_chan_${c.id}` }
        ]));
        buttons.push([{ text: "⬅️ 返回主菜单", callback_data: "menu_main" }]);

        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: `📢 **请选择要管理去重记录的频道：**`,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
          })
        });
      }
      else if (action.startsWith('view_chan_')) {
        const chanId = action.replace('view_chan_', '');
        const count = await getChannelKeyCount(chanId);
        
        const resChan = await telegramFetch(`${TELEGRAM_API}/getChat`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chanId })
        });
        const title = resChan.ok ? resChan.data.result.title : chanId;

        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: `📌 **频道名称：** \`${title}\`\n` +
                  `🆔 **频道 ID：** \`${chanId}\`\n` +
                  `💾 **已记录文件数：** \`${count}\` 个\n\n` +
                  `清空记忆后，该频道曾经上传的文件再次发送时将当作【新文件】重新处理：`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: `🗑️ 清空「${title}」的记忆`, callback_data: `clean_chan_${chanId}` }],
                [{ text: "⬅️ 返回频道列表", callback_data: "select_channel" }]
              ]
            }
          })
        });
      }
      else if (action.startsWith('clean_chan_')) {
        const chanId = action.replace('clean_chan_', '');
        const resClean = await clearChannelKeys(chanId);
        const msgText = resClean.ok 
          ? `✅ **清理完成！**\n已成功抹除该频道 \`${resClean.count}\` 条文件记录。`
          : `❌ 清理失败：${resClean.error}`;

        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: msgText,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回频道列表", callback_data: "select_channel" }]] }
          })
        });
      }
      else if (action === 'toggle_dedup') {
        const settings = await getBotSettingsCached();
        await redisCmd('set', 'config:dedup_enabled', settings.dedupEnabled ? '0' : '1');
        clearSettingsCache();
        const menu = await buildMainMenu();
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup })
        });
      }
      else if (action === 'toggle_backup') {
        const settings = await getBotSettingsCached();
        await redisCmd('set', 'config:backup_enabled', settings.backupEnabled ? '0' : '1');
        clearSettingsCache();
        const menu = await buildMainMenu();
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup })
        });
      }
      else if (action === 'confirm_clean_all') {
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: `⚠️ **高危操作确认**\n\n确定要彻底清空**所有频道**的去重记忆吗？`,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "🔥 确认彻底清空", callback_data: "do_clean_all" },
                  { text: "❌ 取消", callback_data: "menu_main" }
                ]
              ]
            }
          })
        });
      }
      else if (action === 'do_clean_all') {
        const resClean = await clearChannelKeys(null);
        const msgText = resClean.ok ? `✅ **全局清理成功！** 共清除 \`${resClean.count}\` 条数据库记录。` : `❌ 清理失败：${resClean.error}`;
        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: msgText,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回主菜单", callback_data: "menu_main" }]] }
          })
        });
      }
      else if (action === 'system_health') {
        let report = `🩺 **系统健康自检报告**\n\n`;

        const startT = Date.now();
        const pingRes = await redisCmd('ping');
        const delay = Date.now() - startT;
        report += `💾 **Redis 数据库：** ${pingRes.ok ? `✅ 正常 (${delay}ms)` : `❌ 异常 (${pingRes.error})`}\n\n`;

        report += `📢 **频道管理员权限检测：**\n`;
        const channels = await getChannelsInfo();
        const botId = BOT_TOKEN ? BOT_TOKEN.split(':')[0] : '';
        for (const c of channels) {
          const memberRes = await telegramFetch(`${TELEGRAM_API}/getChatMember`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ chat_id: c.id, user_id: botId })
          });

          if (memberRes.ok && memberRes.data?.result?.status === 'administrator') {
            const adm = memberRes.data.result;
            const canDelete = adm.can_delete_messages ? '✅' : '❌无删除权限';
            const canPost = adm.can_post_messages ? '✅' : '❌无发帖权限';
            report += `• **${c.title}**\n  - 发帖: ${canPost} | 删帖: ${canDelete}\n`;
          } else {
            report += `• **${c.title}**\n  - ❌ 机器人未获取到管理员身份\n`;
          }
        }

        await telegramFetch(`${TELEGRAM_API}/editMessageText`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: chatId,
            message_id: msgId,
            text: report,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: "⬅️ 返回主菜单", callback_data: "menu_main" }]] }
          })
        });
      }

      await telegramFetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ callback_query_id: cbId })
      });

      return res.status(200).send('OK');
    }

    // =========================================================
    // 路由 2：私聊逻辑
    // =========================================================
    const message = body.channel_post || body.message;
    if (!message) return res.status(200).send('OK');
    if (!BOT_TOKEN || ALLOWED_CHANNELS.length === 0) return res.status(200).send('OK');

    const currentChatId = String(message.chat.id);
    const isPrivate = message.chat.type === 'private';
    const userId = String(message.from?.id || '');

    if (isPrivate) {
      if (ADMIN_USER_ID && userId !== String(ADMIN_USER_ID)) {
        return res.status(200).send('OK - Unauthorized');
      }
      const menu = await buildMainMenu();
      await telegramFetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: currentChatId, text: menu.text, parse_mode: 'Markdown', reply_markup: menu.reply_markup })
      });
      return res.status(200).send('OK');
    }

    // =========================================================
    // 路由 3：核心频道转发去重逻辑
    // =========================================================
    if (!ALLOWED_CHANNELS.includes(currentChatId)) return res.status(200).send('OK');
    if (message.author_signature === 'Bot' || message.from?.is_bot) return res.status(200).send('OK');

    const messageId = message.message_id;

    // 🎯 精准防自环：判断当前消息是否为机器人刚才 copy 出来的无头消息
    const skipCheck = await redisCmd('get', `skip_msg:${messageId}`);
    if (skipCheck.ok && skipCheck.result) {
      await redisCmd('del', `skip_msg:${messageId}`); // 顺便清理掉此临时 tag
      return res.status(200).send('OK');
    }

    const video = message.video;
    const photo = message.photo;
    const animation = message.animation;
    const document = message.document;

    if (!video && !photo && !animation && !document) return res.status(200).send('OK');

    const chatTitle = message.chat.title || currentChatId;
    
    let uniqueId = null;
    let rawSizeBytes = 0;
    let fileName = null;
    let mediaType = 'Unknown';

    if (video) {
      uniqueId = video.file_unique_id;
      rawSizeBytes = video.file_size || 0;
      fileName = video.file_name || null;
      mediaType = 'Video';
    } else if (photo) {
      uniqueId = photo[photo.length - 1].file_unique_id;
      rawSizeBytes = photo[photo.length - 1].file_size || 0;
      mediaType = 'Photo';
    } else if (animation) {
      uniqueId = animation.file_unique_id;
      rawSizeBytes = animation.file_size || 0;
      fileName = animation.file_name || null;
      mediaType = 'Animation';
    } else if (document) {
      uniqueId = document.file_unique_id;
      rawSizeBytes = document.file_size || 0;
      fileName = document.file_name || null;
      mediaType = 'Document';
    }

    if (!uniqueId) return res.status(200).send('OK');

    const fileSizeFormatted = rawSizeBytes > 0 
      ? (rawSizeBytes > 1048576 ? `${(rawSizeBytes / 1048576).toFixed(2)} MB` : `${(rawSizeBytes / 1024).toFixed(1)} KB`)
      : 'Unknown';

    const settings = await getBotSettingsCached();
    const redisKey = `file:${currentChatId}:${uniqueId}`;

    if (settings.dedupEnabled) {
      // 步骤 1：查询 Redis 中是否已有该文件的记录
      const recordRes = await redisCmd('get', redisKey);

      if (!recordRes.ok) {
        console.error('❌ Redis 查询异常，终止执行以保证安全性');
        return res.status(200).send('OK');
      }

      // -------------------------------------------------------
      // 情况 A：Redis 查到记录，进行【物理存活探针校验】
      // -------------------------------------------------------
      if (recordRes.result !== null) {
        let originMsgId = null;
        try {
          const parsed = JSON.parse(recordRes.result);
          originMsgId = parsed.origin_message_id;
        } catch (e) {
          originMsgId = null;
        }

        let isTargetStillAlive = false;

        if (originMsgId && ADMIN_USER_ID) {
          // 用一次探针 copyMessage 验证频道无头原消息是否仍存在
          const verify = await telegramFetch(`${TELEGRAM_API}/copyMessage`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
              chat_id: ADMIN_USER_ID,
              from_chat_id: currentChatId,
              message_id: originMsgId
            })
          });

          if (verify.ok && verify.data?.ok) {
            isTargetStillAlive = true;
          }
        }

        if (isTargetStillAlive) {
          // 确定为重复文件：静默删掉重复消息，推送管理报告
          if (settings.backupEnabled && ADMIN_USER_ID) {
            processDuplicateBackup(chatTitle, currentChatId, messageId, originMsgId, {
              mediaType, fileName, fileSizeFormatted
            }).catch(err => console.error('备份报告发送失败:', err));
          }

          await safeDeleteMessage(currentChatId, messageId);
          return res.status(200).send('OK');
        } else {
          // 频道里的原无头消息已被删除，清除过期缓存，当新文件重新处理
          console.warn(`🗑️ 原无头消息 #${originMsgId} 在频道已不存在，清除脏数据并当作新文件重新处理。`);
          await redisCmd('del', redisKey);
        }
      }

      // -------------------------------------------------------
      // 情况 B：新文件流程（抢占原子锁 SET NX）
      // -------------------------------------------------------
      const lockPayload = JSON.stringify({
        status: 'pending',
        timestamp: Date.now()
      });

      // 尝试用 SET NX 抢占唯一写锁（锁有效期 600 秒，防死锁）
      const lockRes = await redisCmd('set', redisKey, lockPayload, 'NX', 'EX', '600');

      if (!lockRes.ok || lockRes.result !== 'OK') {
        // 抢锁失败，说明并发请求正在处理该文件，直接删掉重复消息
        await safeDeleteMessage(currentChatId, messageId);
        return res.status(200).send('OK');
      }
    }

    // ---------------------------------------------------------
    // 步骤 2：生成无头消息，保存真实 message_id
    // ---------------------------------------------------------
    const copyProcess = await executeCopyTaskWithRetry(currentChatId, currentChatId, messageId);

    if (copyProcess.success) {
      // 🎯 在 Redis 标记生成的“无头消息 ID”，使得该无头消息再触发 Webhook 时被第一时间的 skipCheck 精准拦截并放行
      await redisCmd('set', `skip_msg:${copyProcess.messageId}`, '1', 'EX', '30');

      // 保存正式的频道无头消息 ID
      if (settings.dedupEnabled) {
        const finalPayload = JSON.stringify({
          origin_chat_id: currentChatId,
          origin_message_id: copyProcess.messageId
        });
        await redisCmd('set', redisKey, finalPayload);
      }

      // 删掉带发送人的原消息
      await safeDeleteMessage(currentChatId, messageId);
    } else {
      // 复制无头消息失败，释放抢占的锁，防止留下无用垃圾数据
      if (settings.dedupEnabled) {
        await redisCmd('del', redisKey);
      }
    }

    return res.status(200).send('OK');

  } catch (err) {
    console.error('Webhook Unhandled Exception:', err);
    return res.status(200).send('OK');
  }
}
