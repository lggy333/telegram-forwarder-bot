export default async function handler(req, res) {
  res.status(200).send('OK'); // 第一时间响应

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

    // 🌟 【核心破局点】：我们不直接 copy 到 CHANNEL_ID，我们用 forwardMessages 先把消息“转发”给机器人自己
    // 机器人自己（对，就是发给 Bot 的 Token 自身，或者随便一个有效 ID，这里可以用 ADMIN_ID 也就是你自己作为中转站）
    const ADMIN_ID = process.env.ADMIN_ID;

    // 1. 先把频道的原消息转发给中转站（你自己的私聊）
    const forwardResp = await fetch(`${TELEGRAM_API}/forwardMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_ID,
        from_chat_id: CHANNEL_ID,
        message_id: messageId
      })
    });
    const forwardResult = await forwardResp.json();

    if (forwardResult.ok) {
      const tempMessageId = forwardResult.result.message_id;

      // 2. 机器人从中转站把这条消息 copyMessage 回频道（这时来源变成了你和 Bot 的私聊，成功绕过“不能自己复制给自己”的限制！）
      const copyResponse = await fetch(`${TELEGRAM_API}/copyMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          from_chat_id: ADMIN_ID,
          message_id: tempMessageId
        })
      });
      const copyResult = await copyResponse.json();

      // 3. 成功发回频道后，把频道里的原消息，以及中转站的临时消息全部斩草除根删掉！
      if (copyResult.ok) {
        // 删除频道原消息
        await fetch(`${TELEGRAM_API}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHANNEL_ID,
            message_id: messageId
          })
        });
        // 删除中转站的临时消息
        await fetch(`${TELEGRAM_API}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: ADMIN_ID,
            message_id: tempMessageId
          })
        });
      }
    }

  } catch (error) {
    console.error('频道中转执行出错:', error);
  }
}
