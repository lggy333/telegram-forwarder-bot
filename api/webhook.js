export default async function handler(req, res) {
  // ⚡ 无论发生什么，第一步先跟 Telegram 服务器打招呼，保证接口绝对不挂掉
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    const { message } = req.body || {};
    if (!message) return;

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const ADMIN_ID = Number(process.env.ADMIN_ID);

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

    // 严格鉴权：只有你本人发的消息才处理
    if (message.from && message.from.id === ADMIN_ID) {
      const chatId = message.chat.id;
      const messageId = message.message_id;
      const text = message.text || '';

      // 智能放过 /start 指令
      if (text === '/start') {
        await fetch(`${TELEGRAM_API}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '🚀 嗨！无痕归档机器人已全线通电。现在发给我的任何内容，都会瞬间无痕同步到你的私有频道中！'
          })
        });
        return;
      }

      // 执行转发和删除逻辑
      // 步骤 1：无痕复制到你的归档频道（不带转发小尾巴）
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

      // 步骤 2：当确认频道成功收到后，瞬间抹除你和 Bot 聊天框里的这条原消息
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
    }
  } catch (error) {
    // 即使代码内部报错，也只在 Vercel 后台打印，绝不把整个机器人搞崩溃
    console.error('Webhook internal execution error:', error);
  }
}
