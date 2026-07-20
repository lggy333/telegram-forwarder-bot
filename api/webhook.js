const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID_ENV = process.env.CHANNEL_ID; 
const ALLOWED_CHANNELS = CHANNEL_ID_ENV ? CHANNEL_ID_ENV.split(',').map(id => id.trim()) : [];
const ADMIN_USER_ID = process.env.ALLOWED_USER_ID || process.env.ADMIN_USER_ID;
const UPSTASH_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 1. 保持你原有的超时封装函数（2500ms 快速响应）
async function telegramFetch(url, options, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    options.signal = controller.signal;
    const response = await fetch(url, options);
    clearTimeout(timeoutId);

    if (response.status === 429) {
      return { ok: false, isRateLimit: true };
    }

    if (!response.ok) return { ok: false, httpStatus: response.status };
    const data = await response.json();
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, isTimeout: err.name === 'AbortError', error: err };
  }
}

// 2. Upstash Redis 原子锁写入 (带超时与 Fail-Safe 机制)
async function checkAndSetRedisNX(key, value = '1') {
  if (!UPSTASH_REST_URL || !UPSTASH_REST_TOKEN) {
    return { success: false, error: 'Upstash Config Missing' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const url = `${UPSTASH_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${UPSTASH_REST_TOKEN}` },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    if (res.status !== 200 || data.error) {
      return { success: false, error: data.error || `HTTP ${res.status}` };
    }

    // result 为 "OK" 代表新文件写入成功；result 为 null 代表之前已存在（重复）
    return { success: true, isDuplicate: data.result !== 'OK' };
  } catch (err) {
    clearTimeout(timeoutId);
    return { success: false, error: err.message };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const message = req.body?.channel_post || req.body?.message;
  if (!message) return res.status(200).send('OK');

  if (!BOT_TOKEN || ALLOWED_CHANNELS.length === 0) {
    return res.status(200).send('OK - Config Missing');
  }

  const currentChatId = String(message.chat.id);
  const isPrivate = message.chat.type === 'private';

  // 频道白名单拦截（私聊消息放行）
  if (!isPrivate && !ALLOWED_CHANNELS.includes(currentChatId)) {
    return res.status(200).send('OK');
  }

  // 忽略机器人自己发布的消息，防止无限死循环
  if (message.author_signature === 'Bot' || message.from?.is_bot) {
    return res.status(200).send('OK');
  }

  const video = message.video;
  const photo = message.photo;
  const animation = message.animation;
  const document = message.document;

  if (!video && !photo && !animation && !document) {
    return res.status(200).send('OK - Ignored Text');
  }

  const messageId = message.message_id;

  // 提取文件唯一特征 ID (file_unique_id)
  let uniqueId = null;
  if (video) uniqueId = video.file_unique_id;
  else if (photo) uniqueId = photo[photo.length - 1].file_unique_id;
  else if (animation) uniqueId = animation.file_unique_id;
  else if (document) uniqueId = document.file_unique_id;

  // =========================================================
  // 核心逻辑 A：Upstash Redis 去重校验
  // =========================================================
  if (uniqueId) {
    const redisKey = `file:${isPrivate ? 'private' : currentChatId}:${uniqueId}`;
    const redisRes = await checkAndSetRedisNX(redisKey);

    // 1. 如果 Redis 报错（如 401 密钥失效或网络超时），执行 Fail-Safe：绝不删消息，直接放行
    if (!redisRes.success) {
      console.warn(`[Redis Fail] ${redisRes.error}，跳过去重校验以保护消息安全。`);
    } 
    // 2. 确认是真实重复文件
    else if (redisRes.isDuplicate) {
      console.log(`[Duplicate Found] 拦截到重复文件 ID: ${uniqueId}`);

      // 动作一：先将重复原消息静音转发到你的私聊做备份
      if (ADMIN_USER_ID) {
        await telegramFetch(`${TELEGRAM_API}/forwardMessage`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: ADMIN_USER_ID,
            from_chat_id: currentChatId,
            message_id: messageId,
            disable_notification: true
          })
        });

        // 动作二：发送重复通知给你的私聊
        await telegramFetch(`${TELEGRAM_API}/sendMessage`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            chat_id: ADMIN_USER_ID,
            text: `⚠️ **[自动去重备份]**\n已拦截并清理频道/聊天 \`${currentChatId}\` 中的重复媒体文件！\n原重复消息已在上方备份 ⬆️`,
            parse_mode: 'Markdown'
          })
        });
      }

      // 动作三：备份完成后，彻底安全地删掉频道里的重复消息
      await telegramFetch(`${TELEGRAM_API}/deleteMessage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ chat_id: currentChatId, message_id: messageId })
      });

      return res.status(200).send('OK - Duplicate Cleaned');
    }
  }

  // =========================================================
  // 核心逻辑 B：全新文件，执行你源码的原版重发与美化逻辑
  // =========================================================
  let method = '';
  const copyBody = { 
    chat_id: isPrivate ? ALLOWED_CHANNELS[0] : currentChatId, // 私聊自动转发到目标频道
    show_caption_above_media: true 
  }; 

  if (video) {
    method = 'sendVideo';
    copyBody.video = video.file_id;
  } else if (photo) {
    method = 'sendPhoto';
    copyBody.photo = photo[photo.length - 1].file_id;
  } else if (animation) {
    method = 'sendAnimation';
    copyBody.animation = animation.file_id;
  } else if (document) {
    const mime = document.mime_type || '';
    if (mime.startsWith('video/')) {
      method = 'sendVideo';
      copyBody.video = document.file_id;
    } else if (mime.startsWith('image/')) {
      method = 'sendPhoto';
      copyBody.photo = document.file_id;
    } else {
      method = 'sendDocument';
      copyBody.document = document.file_id;
    }
  }

  copyBody.caption = message.caption || '';
  copyBody.caption_entities = message.caption_entities || [];

  // 1. 发送美化后的新消息（顶置字幕）
  const copyRes = await telegramFetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(copyBody)
  });

  if (!copyRes.ok || !copyRes.data?.ok) {
    console.warn(`[Skip Msg ${messageId}] Send failed or rate limited.`);
    return res.status(200).send('OK - Rate Limited or Failed');
  }

  // 2. 只有新消息发送成功后，才删除用户/手动发出的原帖子
  await telegramFetch(`${TELEGRAM_API}/deleteMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: currentChatId, message_id: messageId })
  });

  return res.status(200).send('OK');
}
