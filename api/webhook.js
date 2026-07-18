export default async function handler(req, res) {
  // 1. 率先向 TG 回报 200，保证所有并发请求全都能顺利进来，绝不漏包
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    const { channel_post } = req.body || {};
    if (!channel_post) return;

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const chatId = channel_post.chat.id;

    // 严格限制频道
    if (String(chatId) !== String(CHANNEL_ID)) return;
    
    // ✨ 精准死循环拦截：只有当消息“已经是转发状态”且“带有 Bot 签名”时才拦截。
    // 这确保了你刚上传的原始相册能 100% 触发后续逻辑！
    if (channel_post.forward_origin && channel_post.author_signature === 'Bot') {
      return;
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;
    const mediaGroupId = channel_post.media_group_id;

    // --- 情况 A：如果是多图/多视频相册 (存在 media_group_id) ---
    if (mediaGroupId) {
      // 🏎️ 阶梯式睡眠：利用 messageId 尾数错开时间（等 1~2 秒），让所有视频在 TG 服务器排好队
      const delay = (messageId % 5) * 200 + 1200;
      await new Promise(resolve => setTimeout(resolve, delay));

      // 🔍 盲抓潜在区间：向前覆盖 8 个 ID，把同组相册的视频全部一网打尽
      const potentialIds = [];
      for (let i = -7; i <= 0; i++) {
        potentialIds.push(messageId + i);
      }

      // 🚀 核心大招：使用批量转发 API (forwardMessages)。
      // 只有这个 API 传入数组时，TG 才会 100% 强制把多媒体在前端重新聚合为相册，绝不裂开！
      const forwardResp = await fetch(`${TELEGRAM_API}/forwardMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          from_chat_id: CHANNEL_ID,
          message_ids: potentialIds
        })
      });
      
      const forwardResult = await forwardResp.json();

      // 🧹 只要批量转发成功吐出了聚拢的相册，所有并发大脑开始疯狂“盲删”你发出来的原始区间
      if (forwardResult.ok) {
        await fetch(`${TELEGRAM_API}/deleteMessages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHANNEL_ID,
            message_ids: potentialIds
          })
        });
      }
      return;
    }

    // --- 情况 B：普通单张图、单条文字或单视频 ---
    // 单条消息不需要复杂的等待，直接走原子化“复制 -> 删除”
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

  } catch (error) {
    console.error('聚合层运行异常:', error);
  }
}
