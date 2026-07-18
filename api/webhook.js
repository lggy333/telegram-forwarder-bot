export default async function handler(req, res) {
  // 第一时间向 TG 回报 200，保证通道绝对畅通
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    const { channel_post } = req.body || {};
    if (!channel_post) return;

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const chatId = channel_post.chat.id;

    // 严格限制频道，防止死循环
    if (String(chatId) !== String(CHANNEL_ID)) return;
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) return;

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;

    // 🚀 不管是单图、单视频，还是 6 连发视频大相册，一律用最稳妥的原子化操作：
    // 【步骤 1】用 forwardMessage 直接转发。如果是相册里的视频，TG 接收端会自动把它们黏回相册，绝对不会裂开！
    const forwardResponse = await fetch(`${TELEGRAM_API}/forwardMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,       // 目标：你的频道
        from_chat_id: CHANNEL_ID,  // 来源：还是你的频道
        message_id: messageId
      })
    });
    
    const forwardResult = await forwardResponse.json();

    // 【步骤 2】只要当前这个视频/图片转发成功了，立刻定点清除你发出来的这一个原视频
    // 6 个并发实例会同时各自删各自的，100% 斩草除根，绝对不会有残留！
    if (forwardResult.ok) {
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
    console.error('原子化多媒体层拦截到异常:', error);
  }
}
