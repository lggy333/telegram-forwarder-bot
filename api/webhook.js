const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID_ENV = process.env.CHANNEL_ID; 
const ALLOWED_CHANNELS = CHANNEL_ID_ENV ? CHANNEL_ID_ENV.split(',').map(id => id.trim()) : [];
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 快速请求封装，超时时间 2500ms
async function telegramFetch(url, options, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    options.signal = controller.signal;
    const response = await fetch(url, options);
    clearTimeout(timeoutId);

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
    return res.status(200).send('OK - Config Missing');
  }

  const currentChannelId = String(channel_post.chat.id);
  
  if (!ALLOWED_CHANNELS.includes(currentChannelId)) return res.status(200).send('OK');
  if (channel_post.author_signature === 'Bot' || channel_post.from?.is_bot) {
    return res.status(200).send('OK');
  }

  // 忽略纯文本消息（根据需要保留）
  const { video, photo, animation, document } = channel_post;
  if (!video && !photo && !animation && !document) {
    return res.status(200).send('OK - Ignored Text');
  }

  const messageId = channel_post.message_id;

  // 使用 Telegram 原生的 copyMessage 方法，自动保留原消息的所有属性与媒体格式
  const copyRes = await telegramFetch(`${TELEGRAM_API}/copyMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      chat_id: currentChannelId,
      from_chat_id: currentChannelId,
      message_id: messageId,
      show_caption_above_media: true
    })
  });

  // 发送失败或遭遇限流，立即记录并返回 200 OK，防止 Telegram 触发重复 Webhook
  if (!copyRes.ok || !copyRes.data?.ok) {
    console.warn(`[Skip Msg ${messageId}] Copy failed or rate limited.`);
    return res.status(200).send('OK - Failed or Rate Limited');
  }

  // 复制成功后，单次尝试删除原消息
  await telegramFetch(`${TELEGRAM_API}/deleteMessage`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      chat_id: currentChannelId,
      message_id: messageId
    })
  });

  return res.status(200).send('OK');
}
