// api/webhook.js - 增强日志版

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

  // 1. 详细提取并打印媒体文件信息
  const mediaInfo = getMediaInfo(message);

  if (!mediaInfo) {
    console.log(`[消息跳过] 消息 ID ${message.message_id} 不包含媒体文件（纯文本）。`);
    return res.status(200).json({ status: 'passed', reason: 'Not a media message' });
  }

  console.log(`\n------------------ 收到新媒体消息 ------------------`);
  console.log(`消息 ID: ${message.message_id}`);
  console.log(`频道 ID: ${chatId}`);
  console.log(`媒体类型: ${mediaInfo.type}`);
  console.log(`文件名/特征: ${mediaInfo.fileName || '无文件名称'}`);
  console.log(`Telegram Unique ID: ${mediaInfo.uniqueId}`);

  const redisKey = `file:${chatId}:${mediaInfo.uniqueId}`;
  console.log(`生成 Redis Key: ${redisKey}`);

  // 2. 请求 Upstash Redis 并打印完整响应
  const redisResult = await setRedisNXWithLog(UPSTASH_REST_URL, UPSTASH_REST_TOKEN, redisKey, '1');

  if (redisResult !== 'OK') {
    console.log(`🚨 [判定为重复] Redis 返回非 'OK' (实际返回: ${JSON.stringify(redisResult)})`);
    console.log(`正在触发备份并清理消息 ID: ${message.message_id}...`);

    if (ADMIN_USER_ID) {
      // 静音备份给管理员私聊
      const fwdRes = await tgFetch(BOT_TOKEN, 'forwardMessage', {
        chat_id: ADMIN_USER_ID,
        from_chat_id: chatId,
        message_id: message.message_id,
        disable_notification: true
      });
      console.log(`备份转发结果: ${fwdRes.ok ? '成功' : '失败'}`);

      // 发送重复说明通知
      await tgFetch(BOT_TOKEN, 'sendMessage', {
        chat_id: ADMIN_USER_ID,
        text: `⚠️ **[自动去重通知]**\n检测到频道 \`${chatId}\` 存在重复文件！\n类型: \`${mediaInfo.type}\` | ID: \`${mediaInfo.uniqueId}\`\n原消息已**备份到上方** ⬆️，频道内重复消息已清理。`,
        parse_mode: 'Markdown'
      });
    }

    // 删除频道消息
    const delRes = await tgFetch(BOT_TOKEN, 'deleteMessage', {
      chat_id: chatId,
      message_id: message.message_id
    });
    console.log(`删除频道消息结果: ${delRes.ok ? '成功' : '失败'}`);
    console.log(`----------------------------------------------------\n`);
  } else {
    console.log(`✅ [判定为全新文件] Redis 写入 'OK'，成功录入数据库。`);
    console.log(`----------------------------------------------------\n`);
  }

  return res.status(200).json({ status: 'success' });
}

/**
 * 获取媒体详细信息
 */
function getMediaInfo(msg) {
  if (msg.photo) {
    const item = msg.photo[msg.photo.length - 1];
    return { type: 'photo', uniqueId: item.file_unique_id };
  }
  if (msg.video) {
    return { type: 'video', uniqueId: msg.video.file_unique_id, fileName: msg.video.file_name };
  }
  if (msg.animation) {
    return { type: 'animation', uniqueId: msg.animation.file_unique_id };
  }
  if (msg.document) {
    return { type: 'document', uniqueId: msg.document.file_unique_id, fileName: msg.document.file_name };
  }
  if (msg.audio) {
    return { type: 'audio', uniqueId: msg.audio.file_unique_id, fileName: msg.audio.file_name };
  }
  if (msg.voice) {
    return { type: 'voice', uniqueId: msg.voice.file_unique_id };
  }
  return null;
}

/**
 * Upstash Redis 写入带详细日志打印
 */
async function setRedisNXWithLog(url, token, key, value) {
  try {
    const fetchUrl = `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX`;
    console.log(`[Redis 发起请求] GET ${fetchUrl}`);

    const res = await fetch(fetchUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();

    console.log(`[Redis 响应状态码] ${res.status}`);
    console.log(`[Redis 响应内容]`, JSON.stringify(data));

    return data.result;
  } catch (err) {
    console.error(`[Redis 请求报错]`, err);
    return null;
  }
}

/**
 * Telegram API 请求封装
 */
async function tgFetch(token, method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (err) {
    console.error(`Telegram API (${method}) 报错:`, err);
    return { ok: false };
  }
}
