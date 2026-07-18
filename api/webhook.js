export default async function handler(req, res) {
  // 无论如何，第一时间向 TG 服务器返回 200，确保机器人稳如磐石
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    // ✨ 频道消息的字段叫 channel_post，而不是普通的 message
    const { channel_post } = req.body || {};
    if (!channel_post) return;

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    
    // 注意：频道里没有 message.from.id，我们直接校验这个频道是不是你的目标归档频道
    const chatId = channel_post.chat.id;
    
    if (String(chatId) === String(CHANNEL_ID)) {
      const messageId = channel_post.message_id;
      const text = channel_post.text || '';

      // 1. 检查这条消息是不是机器人自己发的，如果是自己发的就别理它，否则会无限死循环
      if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
        return;
      }

      const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

      // 2. 步骤：先由机器人使用 copyMessage 重新复制一份发到这个频道（此时发送者会变成机器人，洗掉你的名字）
      const copyResponse = await fetch(`${TELEGRAM_API}/copyMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,       // 目标：还是这个频道
          from_chat_id: CHANNEL_ID,  // 来源：也是这个频道
          message_id: messageId
        })
      });

      const copyResult = await copyResponse.json();

      // 3. 步骤：当机器人复制成功后，瞬间把你刚才发的那条原消息抹除
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
    }
  } catch (error) {
    console.error('频道内归档执行出错:', error);
  }
}
