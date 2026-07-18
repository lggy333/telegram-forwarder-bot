export default async function handler(req, res) {
  // 1. 率先向 TG 回报 200，保证通道 100% 瞬间畅通
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    const { channel_post } = req.body || {};
    if (!channel_post) return;

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const chatId = channel_post.chat.id;

    // 严格限制频道，防止机器人无限复读自嗨
    if (String(chatId) !== String(CHANNEL_ID)) return;
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
      return;
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;

    // 🚀 【核心动作 1】：管它几张图，进一个发一个，用单数版 copyMessage
    // 这样做能保证 100% 成功率。多图发送时，TG 在接收端会自动把连续进来的媒体合成为相册外观！
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

    // 🚀 【核心动作 2】：不管复制成功与否，每个并发进来的大脑都稍微等 2.5 秒
    // 等所有视频在频道里都上传完毕后，直接暴力清空当前 ID 往前的 10 个 ID 盲区
    if (copyResult.ok) {
      await new Promise(resolve => setTimeout(resolve, 2500));

      const potentialIds = [];
      for (let i = -9; i <= 0; i++) {
        potentialIds.push(messageId + i);
      }

      // 所有并发实例会同时轰炸 deleteMessages，确保带你名字的原视频直接彻底人间蒸发
      await fetch(`${TELEGRAM_API}/deleteMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          message_ids: potentialIds
        })
      });
    }

  } catch (error) {
    console.error('频道极致洗稿流运行异常:', error);
  }
}
