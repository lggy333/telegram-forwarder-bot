// api/webhook.js - Telegram 自动去重与防丢失备份 Serverless 函数

export default async function handler(req, res) {
  // 1. 只响应 Telegram 发来的 POST 请求
  if (req.method !== 'POST') {
    return res.status(200).json({ status: 'ok', message: 'Webhook is active!' });
  }

  const update = req.body;
  // 获取 Telegram 消息对象（频道消息在 channel_post，普通消息/群组在 message）
  const message = update.channel_post || update.message;

  if (!message) {
    return res.status(200).json({ status: 'ignored', reason: 'No message content' });
  }

  // 2. 读取你在 Vercel 中设置的环境变量
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const ADMIN_USER_ID = process.env.ALLOWED_USER_ID || process.env.ADMIN_USER_ID; // 适配你的 ALLOWED_USER_ID
  const CHANNEL_IDS = (process.env.CHANNEL_ID || '').split(',').map(id => id.trim());
  const UPSTASH_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  const chatId = String(message.chat.id);

  // 3. 频道白名单过滤（若配置了 CHANNEL_ID 则仅处理列表中的频道）
  if (CHANNEL_IDS.length > 0 && CHANNEL_IDS[0] !== '' && !CHANNEL_IDS.includes(chatId)) {
    return res.status(200).json({ status: 'ignored', reason: 'Channel not in whitelist' });
  }

  // 4. 提取媒体文件唯一的 file_unique_id
  const uniqueId = getMediaUniqueId(message);

  // 纯文本消息无唯一媒体 ID，直接跳过去重
  if (!uniqueId) {
    return res.status(200).json({ status: 'passed', reason: 'Not a media message' });
  }

  // Redis Key 设计：带频道 ID 隔离，确保不同频道互不干涉
  const redisKey = `file:${chatId}:${uniqueId}`;

  // 5. 尝试在 Redis 中写入锁（NX 模式：仅在 Key 不存在时写入成功）
  const redisRes = await setRedisNX(UPSTASH_REST_URL, UPSTASH_REST_TOKEN, redisKey, '1');

  if (redisRes !== 'OK') {
    // =========================================================
    // 🚨 拦截到重复文件：执行“先备份，后清理”安全机制
    // =========================================================
    
    if (ADMIN_USER_ID) {
      // 步骤 1：静音将原重复消息完整转发到你的 Telegram 私聊进行备份
      await tgFetch(BOT_TOKEN, 'forwardMessage', {
        chat_id: ADMIN_USER_ID,
        from_chat_id: chatId,
        message_id: message.message_id,
        disable_notification: true
      });

      // 步骤 2：给你发送一条防丢失提醒说明
      await tgFetch(BOT_TOKEN, 'sendMessage', {
        chat_id: ADMIN_USER_ID,
        text: `⚠️ **[自动去重通知]**\n检测到频道 \`${chatId}\` 存在重复文件！\n原重复消息已**备份到上方** ⬆️，频道内的原消息已被自动清理。`,
        parse_mode: 'Markdown'
      });
    }

    // 步骤 3：确认备份完成后，安全删掉频道里的重复消息
    await tgFetch(BOT_TOKEN, 'deleteMessage', {
      chat_id: chatId,
      message_id: message.message_id
    });

    console.log(`[去重成功] 已清理频道 ${chatId} 中的重复消息 (ID: ${message.message_id})`);
  } else {
    // =========================================================
    // ✅ 全新文件：首次出现，已成功存入 Redis
    // =========================================================
    console.log(`[全新文件] 已录入 Redis，频道: ${chatId}, UniqueID: ${uniqueId}`);
  }

  return res.status(200).json({ status: 'success' });
}

/**
 * 提取各种媒体格式的 file_unique_id
 */
function getMediaUniqueId(msg) {
  if (msg.photo) return msg.photo[msg.photo.length - 1].file_unique_id; // 图片取最高清的一张
  if (msg.video) return msg.video.file_unique_id;
  if (msg.animation) return msg.animation.file_unique_id; // GIF
  if (msg.document) return msg.document.file_unique_id;   // 文件/文档
  if (msg.audio) return msg.audio.file_unique_id;         // 音频
  if (msg.voice) return msg.voice.file_unique_id;         // 语音
  return null;
}

/**
 * 调用 Upstash Redis REST API 进行 SET NX 原子写入
 */
async function setRedisNX(url, token, key, value) {
  try {
    const fetchUrl = `${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX`;
    const res = await fetch(fetchUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    return data.result;
  } catch (err) {
    console.error('Upstash Redis 请求失败:', err);
    return null;
  }
}

/**
 * 发送 Telegram API 请求工具函数
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
    console.error(`Telegram API (${method}) 请求异常:`, err);
    return { ok: false };
  }
}
