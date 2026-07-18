// 全局缓存，用于在 Vercel 实例存活时辅助合并
let lastMediaGroupId = null;
let pendingMessages = [];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }

    const { channel_post } = req.body || {};
    if (!channel_post) {
      return res.status(200).send('OK');
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const chatId = channel_post.chat.id;

    // 严格限制频道 ID，并防止机器人自身死循环
    if (String(chatId) !== String(CHANNEL_ID)) return res.status(200).send('OK');
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
      return res.status(200).send('OK');
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;
    const mediaGroupId = channel_post.media_group_id;

    // ====================================================
    // --- 情况 A：如果是多图/相册 (存在 media_group_id) ---
    // ====================================================
    if (mediaGroupId) {
      if (lastMediaGroupId !== mediaGroupId) {
        lastMediaGroupId = mediaGroupId;
        pendingMessages = [];
      }

      pendingMessages.push(messageId);

      // 卡住当前请求 1.2 秒，给足并发请求把图片 ID 攒齐的时间
      await sleep(1200);

      const currentIds = [...new Set(pendingMessages)].sort((a, b) => a - b);
      
      // 只有最新到位的那个并发请求，才有资格执行批量转发与删除
      if (messageId === currentIds[currentIds.length - 1]) {
        
        // ✨ 核心修正：使用 forwardMessages 代替 copyMessages，允许同一个频道自转
        const batchForwardResp = await fetch(`${TELEGRAM_API}/forwardMessages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHANNEL_ID,
            from_chat_id: CHANNEL_ID,
            message_ids: currentIds
          })
        });
        const batchForwardResult = await batchForwardResp.json();

        // 转发成功后，立刻斩草除根批量删除原消息
        if (batchForwardResult.ok) {
          await fetch(`${TELEGRAM_API}/deleteMessages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: CHANNEL_ID,
              message_ids: currentIds
            })
          });
        }
        
        // 功成身退，清空标记
        lastMediaGroupId = null;
        pendingMessages = [];
      }

      return res.status(200).send('OK');
    }

    // ====================================================
    // --- 情况 B：普通单张图或单条文字 ---
    // ====================================================
    // ✨ 同样，单条也使用 forwardMessage 自转
    const forwardResponse = await fetch(`${TELEGRAM_API}/forwardMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        from_chat_id: CHANNEL_ID,
        message_id: messageId
      })
    });
    const forwardResult = await forwardResponse.json();

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
    console.error('运行期发生拦截:', error);
  }

  return res.status(200).send('OK');
}
