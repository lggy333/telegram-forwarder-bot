export default async function handler(req, res) {
  // 1. 严格限制只处理 POST 请求
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const { message } = req.body || {};
  if (!message) {
    return res.status(200).send('No message received');
  }

  // 2. 读取你在 Vercel 配置的环境变量
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHANNEL_ID = process.env.CHANNEL_ID;
  const ADMIN_ID = Number(process.env.ADMIN_ID);

  const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

  // 3. 严格鉴权：只有你本人（ADMIN_ID）发给 Bot 的消息才触发逻辑
  if (message.from && message.from.id === ADMIN_ID) {
    const chatId = message.chat.id;
    const messageId = message.message_id;

    try {
      // 动作 A：使用 copyMessage 无痕复制到归档频道
      const copyResponse = await fetch(`${TELEGRAM_API}/copyMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          from_chat_id: chatId,
          message_id: messageId
        })
      });
      
      const copyResult = await copyResponse.json();

      // 动作 B：频道接收成功后，瞬间抹除你和 Bot 聊天框里的原消息
      if (copyResult.ok) {
        await fetch(`${TELEGRAM_API}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId
          })
        });
      }
    } catch (error) {
      console.error('无痕归档执行出错:', error);
    }
  }

  // 4. 无论成功与否，必须向 Telegram 回应 200，防止其死循环重发
  return res.status(200).send('OK');
}
