// ==========================================
// 性能优化点 1：提取常量至全局作用域（极高提升）
// ==========================================
// 在 Vercel 或常驻 Node 运行环境下，全局变量只在冷启动时初始化一次。
// 移出 handler 可以避免每次收到 Telegram 消息都去读取 process.env 和拼接字符串，极大节省 CPU 耗时。
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const DELETE_URL = `${TELEGRAM_API}/deleteMessage`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * 辅助函数：精简高效的 Fetch 封装
 */
async function telegramFetch(url, options, timeoutMs = 8000) {
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
  // 性能优化点 2：最快路径返回，不符合条件直接秒切断
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { channel_post } = req.body || {};
  if (!channel_post) return res.status(200).send('OK');

  if (!BOT_TOKEN || !CHANNEL_ID) {
    console.error('[配置错误] 缺少必要的环境变量');
    return res.status(500).send('Configuration Error');
  }

  // 严格限制频道与机器人自身，防止死循环
  if (String(channel_post.chat.id) !== CHANNEL_ID) return res.status(200).send('OK');
  if (channel_post.author_signature === 'Bot' || channel_post.from?.is_bot) {
    return res.status(200).send('OK');
  }

  const messageId = channel_post.message_id;

  // ==========================================
  // 性能优化点 3：扁平化媒体判定（减少对象属性深度查找）
  // ==========================================
  let method = 'copyMessage';
  const copyBody = { chat_id: CHANNEL_ID };

  const video = channel_post.video;
  const photo = channel_post.photo;
  const animation = channel_post.animation;
  const document = channel_post.document;

  if (video) {
    method = 'sendVideo';
    copyBody.video = video.file_id;
  } else if (photo) {
    method = 'sendPhoto';
    copyBody.photo = photo[photo.length - 1].file_id; // 拿最高清图
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
    // 纯文本等普通消息走无脑克隆
    copyBody.from_chat_id = CHANNEL_ID;
    copyBody.message_id = messageId;
  }

  // 仅在属于媒体重新发送时注入样式，避免对普通 copy 注入冗余字段
  if (method !== 'copyMessage') {
    copyBody.caption = channel_post.caption || '';
    copyBody.caption_entities = channel_post.caption_entities || [];
  }

  const fetchOptions = {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(copyBody)
  };

  // 核心步骤一：执行发图/视频
  let copyRes = await telegramFetch(`${TELEGRAM_API}/${method}`, fetchOptions);

  // 429 限流原地避让
  if (!copyRes.ok && copyRes.isRateLimit && copyRes.retryAfter <= 3) {
    await new Promise(resolve => setTimeout(resolve, copyRes.retryAfter * 1000));
    copyRes = await telegramFetch(`${TELEGRAM_API}/${method}`, fetchOptions);
  }

  if (!copyRes.ok) {
    if (copyRes.isRateLimit) return res.status(429).send('Too Many Requests');
    if (copyRes.isTimeout || copyRes.httpStatus >= 500) return res.status(500).send('Telegram Server Error');
    return res.status(200).send('OK');
  }
  if (!copyRes.data?.ok) {
    if (copyRes.data?.error_code === 400) return res.status(200).send('OK');
    return res.status(500).send('Copy Business Logic Error');
  }

  // 核心步骤二：严格紧跟删除
  const deleteOptions = {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ chat_id: CHANNEL_ID, message_id: messageId })
  };

  // ==========================================
  // 性能优化点 4：异步解耦删除（时延减半利器）
  // ==========================================
  // 【注意】：如果你使用的是常驻服务器（如 独立VPS、Docker、宝塔、PM2等），
  // 可以取消下面这行代码的注释。这样会立即向 Telegram 返回 200 成功，而删除动作在后台静默执行，
  // 从而让整个 Webhook 的网络响应速度直接暴增 50% 左右！
  // (如果是 Vercel 等 Serverless 平台请保持注释状态，防止进程被强制冻结导致删除不成功)。
  
  // res.status(200).send('OK'); 

  const deleteRes = await telegramFetch(DELETE_URL, deleteOptions);

  // 删除抖动挽救
  if (!deleteRes.ok && (deleteRes.isTimeout || deleteRes.isRateLimit)) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await telegramFetch(DELETE_URL, deleteOptions);
  }

  return res.status(200).send('OK');
}
