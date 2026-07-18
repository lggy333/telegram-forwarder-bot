const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID_ENV = process.env.CHANNEL_ID; 
// 支持逗号分隔的多个频道 ID
const ALLOWED_CHANNELS = CHANNEL_ID_ENV ? CHANNEL_ID_ENV.split(',').map(id => id.trim()) : [];
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const DELETE_URL = `${TELEGRAM_API}/deleteMessage`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function telegramFetch(url, options, timeoutMs = 3500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    options.signal = controller.signal;
    const response = await fetch(url, options);
    clearTimeout(timeoutId);

    if (response.status === 429) {
      const errorData = await response.json().catch(() => ({}));
      return { 
        ok: false, 
        isRateLimit: true, 
        retryAfter: errorData.parameters?.retry_after || 2 
      };
    }

    if (!response.ok) return { ok: false, httpStatus: response.status };
    const data = await response.json();
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timeoutId);
    return { ok: false, isTimeout: err.name === 'AbortError', error: err };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { channel_post } = req.body || {};
  if (!channel_post) return res.status(200).send('OK');

  if (!BOT_TOKEN || ALLOWED_CHANNELS.length === 0) {
    return res.status(500).send('Configuration Error');
  }

  // 【动态识别】获取当前触发 Webhook 的频道 ID
  const currentChannelId = String(channel_post.chat.id);
  
  // 检查该频道是否在允许的白名单内
  if (!ALLOWED_CHANNELS.includes(currentChannelId)) return res.status(200).send('OK');
  if (channel_post.author_signature === 'Bot' || channel_post.from?.is_bot) {
    return res.status(200).send('OK');
  }

  const messageId = channel_post.message_id;
  let method = 'copyMessage';
  const copyBody = { chat_id: currentChannelId }; // 动态写入当前频道

  const video = channel_post.video;
  const photo = channel_post.photo;
  const animation = channel_post.animation;
  const document = channel_post.document;

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
  } else {
    copyBody.from_chat_id = currentChannelId;
    copyBody.message_id = messageId;
  }

  if (method !== 'copyMessage') {
    copyBody.caption = channel_post.caption || '';
    copyBody.caption_entities = channel_post.caption_entities || [];
  }

  const fetchOptions = {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(copyBody)
  };

  let copyRes = await telegramFetch(`${TELEGRAM_API}/${method}`, fetchOptions);

  if (!copyRes.ok && copyRes.isRateLimit && copyRes.retryAfter <= 2) {
    await new Promise(resolve => setTimeout(resolve, copyRes.retryAfter * 1000));
    copyRes = await telegramFetch(`${TELEGRAM_API}/${method}`, fetchOptions);
  }

  if (!copyRes.ok) {
    if (copyRes.isRateLimit) return res.status(429).send('Too Many Requests');
    if (copyRes.isTimeout || copyRes.httpStatus >= 500) return res.status(500).send('Telegram Error');
    return res.status(200).send('OK');
  }
  if (!copyRes.data?.ok) {
    if (copyRes.data?.error_code === 400) return res.status(200).send('OK');
    return res.status(500).send('Business Error');
  }

  // 严格紧跟删除
  const deleteRes = await telegramFetch(DELETE_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: currentChannelId, message_id: messageId }) // 动态删除当前频道的旧消息
  });

  if (!deleteRes.ok && (deleteRes.isTimeout || deleteRes.isRateLimit)) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await telegramFetch(DELETE_URL, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ chat_id: currentChannelId, message_id: messageId })
    });
  }

  return res.status(200).send('OK');
}
