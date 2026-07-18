export default async function handler(req, res) {
  // 1. 无论如何，第一时间给 TG 回应 200，保证通道绝对畅通
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
    
    // 拦截机器人自己发的消息（通过签名判断），防止无限复读死循环
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
      return;
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;

    // 🚀 【核心大招】：无论是单文本、单视频，还是多图相册，一律使用官方最高效的批量无痕复制 API！
    // 哪怕数组里只有当前这一条 ID，TG 也会自动识别并保持其多媒体相册的聚合结构！
    const batchCopyResp = await fetch(`${TELEGRAM_API}/copyMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        from_chat_id: CHANNEL_ID,
        message_ids: [messageId] // 把单条 ID 包装成数组传入
      })
    });
    
    const batchCopyResult = await batchCopyResp.json();

    // 2. 只要复制成功了，立刻定点清除你发出来的这一个原始消息
    if (batchCopyResult.ok) {
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
    // 如果万一报错，直接打印在 Vercel 日志里，但绝不卡死程序
    console.error('Telegram Webhook 运行期发生异常:', error);
  }
}
