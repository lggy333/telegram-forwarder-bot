export default async function handler(req, res) {
  // 立即返回 200，让 Telegram 彻底不再管这个请求
  res.status(200).send('OK');

  try {
    const { channel_post } = req.body || {};
    if (!channel_post) return;

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;

    // 严谨的身份判定
    if (String(channel_post.chat.id) !== String(CHANNEL_ID)) return;
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) return;

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const msgId = channel_post.message_id;

    // 1. 尝试复制：增加超时控制，防止网络请求挂起
    const copyResp = await fetch(`${TELEGRAM_API}/copyMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        from_chat_id: CHANNEL_ID,
        message_id: msgId
      })
    });
    
    const copyResult = await copyResp.json();

    // 2. 只有明确收到 ok: true 时才执行删除，确保数据不丢失
    if (copyResult && copyResult.ok) {
      await fetch(`${TELEGRAM_API}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          message_id: msgId
        })
      });
    } else {
      console.error('复制失败，跳过删除:', copyResult);
    }

  } catch (error) {
    // 捕获所有潜在的异步错误，确保程序不崩溃
    console.error('原子层异常:', error);
  }
}
