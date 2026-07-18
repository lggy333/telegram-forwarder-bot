// ==========================================
// Vercel 优化：全局常量常驻内存，规避冷启动重复计算
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const DELETE_URL = `${TELEGRAM_API}/deleteMessage`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * 针对 Vercel 优化的 Fetch 辅助函数
 * 免费版硬限 10s，单次请求超时控制在 3.5s 内是最安全的
 */
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
  // 最快路径拦截
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { channel_post } = req.body || {};
  if (!channel_post) return res.status(200).send('OK');

  if (!BOT_TOKEN || !CHANNEL_ID) {
    return res.status(500).send('Configuration Error');
  }

  if (String(channel_post.chat.id) !== CHANNEL_ID) return res.status(200).send('OK');
  if (channel_post.author_signature === 'Bot' || channel_post.from?.is_bot) {
    return res.status(200).send('OK');
  }

  const messageId = channel_post.message_id;

  // 扁平化变量提取，加速 V8 引擎解析
  let method = 'copyMessage';
  const copyBody = { chat_id: CHANNEL_ID };

  const video = channel_post.video;
  const photo = channel_post.photo;
  const animation = channel_post.animation;
  const document = channel_post.document;

  // 深度媒体重映射（洗掉模糊关键逻辑）
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
    copyBody.from_chat_id = CHANNEL_ID;
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

  // 核心步骤一：发送（去模糊）
  let copyRes = await telegramFetch(`${TELEGRAM_API}/${method}`, fetchOptions);

  // 429 限流原地小碎步避让（仅当等待时间短时重试，防止 Vercel 超时）
  if (!copyRes.ok && copyRes.isRateLimit && copyRes.retryAfter <= 2) {
    await new Promise(resolve => setTimeout(resolve, copyRes.retryAfter * 1000));
    copyRes = await telegramFetch(`${TELEGRAM_API}/${method}`, fetchOptions);
  }

  // 异常高可用决策
  if (!copyRes.ok) {
    if (copyRes.isRateLimit) return res.status(429).send('Too Many Requests');
    if (copyRes.isTimeout || copyRes.httpStatus >= 500) return res.status(500).send('Telegram Error');
    return res.status(200).send('OK');
  }
  if (!copyRes.data?.ok) {
    if (copyRes.data?.error_code === 400) return res.status(200).send('OK');
    return res.status(500).send('Business Error');
  }

  // 核心步骤二：严格紧跟删除（在 Vercel 上必须 await 确保执行）
  const deleteOptions = {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: CHANNEL_ID, message_id: messageId })
  };

  const deleteRes = await telegramFetch(DELETE_URL, deleteOptions);

  // 删除网络抖动挽救（同样受控于 3.5s 超时）
  if (!deleteRes.ok && (deleteRes.isTimeout || deleteRes.isRateLimit)) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await telegramFetch(DELETE_URL, deleteOptions);
  }

  return res.status(200).send('OK');
}
