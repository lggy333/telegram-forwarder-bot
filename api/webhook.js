export default async function handler(req, res) {
  // ⚡ 进来立刻先响应 200，绝不让 Vercel 实例有任何机会超时或者被 Telegram 判定死机
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    const { channel_post } = req.body || {};
    if (!channel_post) return;

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const ADMIN_ID = process.env.ADMIN_ID; // 你的个人 TG ID
    const chatId = channel_post.chat.id;

    // 严格限制频道 ID，并防止机器人自身死循环
    if (String(chatId) !== String(CHANNEL_ID)) return;
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
      return;
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;

    // 🚀【无状态并发核心逻辑】
    // 无论是单图、文字、还是多图相册里的某一张，每一个并发请求进来，各自只对自己负责：
    
    // 步骤 1：先无痕复制到你本人的私聊中（由于是发给个人，TG 100% 允许，且会完美剥离所有转发来源和署名）
    const copyToAdminResp = await fetch(`${TELEGRAM_API}/copyMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_ID,
        from_chat_id: CHANNEL_ID,
        message_id: messageId
      })
    });
    const copyToAdminResult = await copyToAdminResp.json();

    if (copyToAdminResult.ok) {
      const tempMessageId = copyToAdminResult.result.message_id;

      // 步骤 2：机器人立刻把你私聊里刚生成的干净消息，再次 copyMessage 拷回频道！
      // 此时消息的来源变成了“你与机器人的私聊”，完美绕过了“不能自己复制给自己”的底层限制！
      const copyBackToChannelResp = await fetch(`${TELEGRAM_API}/copyMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          from_chat_id: ADMIN_ID,
          message_id: tempMessageId
        })
      });
      const copyBackResult = await copyBackToChannelResp.json();

      // 步骤 3：只要拷回去了，立刻把频道里的原消息、以及你私聊里的中转消息全部抹除，不留任何痕迹！
      if (copyBackResult.ok) {
        // 强行删除频道里带有你名字/眼睛的原消息
        await fetch(`${TELEGRAM_API}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHANNEL_ID,
            message_id: messageId
          })
        });

        // 强行清理你私聊里的临时缓存消息，保持私聊干净
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
    console.error('运行期致命拦截:', error);
  }
}
