// api/webhook.js - 故障安全与精确定位版

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'ok', message: 'Webhook is active!' });
  }

  const update = req.body;
  const message = update.channel_post || update.message;

  if (!message) {
    return res.status(200).json({ status: 'ignored', reason: 'No message content' });
  }

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const ADMIN_USER_ID = process.env.ALLOWED_USER_ID || process.env.ADMIN_USER_ID;
  const CHANNEL_IDS = (process.env.CHANNEL_ID || '').split(',').map(id => id.trim());
  const UPSTASH_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  const chatId = String(message.chat.id);

  if (CHANNEL_IDS.length > 0 && CHANNEL_IDS[0] !== '' && !CHANNEL_IDS.includes(chatId)) {
    return res.status(200).json({ status: 'ignored', reason: 'Channel not in whitelist' });
  }

  const mediaInfo = getMediaInfo(message);
  if (!mediaInfo) {
    return res.status(200).json({ status: 'passed', reason: 'Not a media message' });
  }

  console.log(`\n------------------ 收到新媒体消息 ------------------`);
  console.log(`消息 ID: ${message.message_id} | 类型: ${mediaInfo.type}`);
  console.log(`Telegram Unique ID: ${mediaInfo.uniqueId}`);

  const redisKey = `file:${chatId}:${mediaInfo.uniqueId}`;

  // 发起 Redis SET NX 请求
  const { success, isDuplicate, error } = await checkAndSetRedisNX(UPSTASH_REST_URL, UPSTASH_REST_TOKEN, redisKey, '1');

  // 1. 如果 Redis 本身报错（如 401 Token 错误），绝对不能删消息！
  if (!success) {
    console.error(`❌ [数据库报错] Redis 请求失败: ${error}，为保护数据，不执行删除动作。`);
    return res.status(200).json({ status: 'error', reason: 'Redis Error, safety bypassed' });
  }

  // 2. 确定是真实重复文件（Redis Key 已存在，SET NX 返回 null）
  if (isDuplicate) {
    console.log(`🚨 [确认重复文件] 消息 ID: ${message.message_id} 已在频道中发送过！`);

    if (ADMIN_USER_ID) {
      await tgFetch(BOT_TOKEN, 'forwardMessage', {
        chat_id: ADMIN_USER_ID,
        from_chat_id: chatId,
        message_id: message.message_id,
        disable_notification: true
      });

      await tgFetch(BOT_TOKEN, 'sendMessage', {
        chat_id: ADMIN_USER_ID,
        text: `⚠️ **[自动去重通知]**\n检测到频道 \`${chatId}\` 存在重复文件！\n类型: \`${mediaInfo.type}\` | ID: \`${mediaInfo.uniqueId}\`\n原消息已备份到上方 ⬆️，频道重复消息已清理。`,
        parse_mode: 'Markdown'
      });
    }

    await tgFetch(BOT_TOKEN, 'deleteMessage', {
      chat_id: chatId,
      message_id: message.message_id
    });
    console.log(`✅ 已完成备份与重复清理。`);
  } else {
    // 3. 全新文件，首次写入成功
    console.log(`✅ [全新文件] 已成功录入 Redis，保留在频道。`);
  }

  console.log(`----------------------------------------------------\n`);
  return res.status(200).json({ status: 'success' });
}

function getMediaInfo(msg) {
  if (msg.photo) return { type: 'photo', uniqueId: msg.photo[msg.photo.length - 1].file_unique_id };
  if (msg.video) return { type: 'video', uniqueId: msg.video.file_unique_id };
  if (msg.animation) return { type: 'animation', uniqueId: msg.animation.file_unique_id };
  if (msg.document) return { type: 'document', uniqueId: msg.document.file_unique_id };
  if (msg.audio) return { type: 'audio', uniqueId: msg.audio.file_unique_id };
  if (msg.voice) return { type: 'voice', uniqueId: msg.voice.file_unique_id };
  return null;
}

/**
 * 严谨判断 Redis 返回状态
 */
async function checkAndSetRedisNX(url, token, key, value) {
  try {
    const fetchUrl = `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX`;
    const res = await fetch(fetchUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();

    if (res.status !== 200 || data.error) {
      return { success: false, isDuplicate: false, error: data.error || `HTTP ${res.status}` };
    }

    // SET ... NX 成功时 data.result 为 "OK"
    // Key 已存在时 data.result 为 null
    if (data.result === 'OK') {
      return { success: true, isDuplicate: false };
    } else {
      return { success: true, isDuplicate: true };
    }
  } catch (err) {
    return { success: false, isDuplicate: false, error: err.message };
  }
}

async function tgFetch(token, method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (err) {
    return { ok: false };
  }
}
