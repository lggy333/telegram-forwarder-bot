export default async function handler(req, res) {
  // 1. 进来立刻先响应 200，绝不让 Telegram 延迟重发
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    const { channel_post } = req.body || {};
    if (!channel_post) return;

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const chatId = channel_post.chat.id;

    // 严格限制频道 ID，并防止机器人自身死循环
    if (String(chatId) !== String(CHANNEL_ID)) return;
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
      return;
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;

    // 🚀 【无状态核心逻辑】：
    // 无论是单图、文字、还是多图相册中的某一张，我们都只把它当成“独立的一条消息”来处理。
    // 我们用单数版的 copyMessage 把它复制出来。
    // 对于多图相册，因为并发速度极快，Telegram 收到这几条复制请求后，会自动在频道里把它们组合回相册！
    const copyResponse = await fetch(`${TELEGRAM_API}/copyMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        from_chat_id: CHANNEL_ID,
        message_id: messageId
      })
    });
    
    const copyResult = await copyResponse.json();

    // 3. 复制成功后，该请求对应的实例立刻精准删除属于它自己的那张原图，绝不越界
    if (copyResult.ok) {
      await fetch(`${TELEGRAM_API}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          message_id: messageId
        })
      });
    }

  } catch (error) {
    console.error('运行期发生致命拦截:', error);
  }
}
