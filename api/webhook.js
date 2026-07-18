export default async function handler(req, res) {
  // 无论如何，第一时间给 TG 回应 200，保证通道绝对不堵塞
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
    
    // 拦截机器人自己发的签名消息，防止无限复读死循环
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
      return;
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;
    const mediaGroupId = channel_post.media_group_id;

    // --- 【核心逻辑】如果是多图/多视频相册 ---
    if (mediaGroupId) {
      // 🏎️ 动态错位睡眠：ID 越小等得越短，ID 最大（最后一个视频）等得最久
      // 确保最后一个请求醒来时，前面的视频已经在 TG 服务器里排好队了
      const suffix = messageId % 10; 
      const delay = suffix * 350 + 1200; // 阶梯式延迟，给足大视频上传和同步的时间
      await new Promise(resolve => setTimeout(resolve, delay));

      // 🔍 盲搜区间：因为不知道前面具体有几个视频，我们直接抓取当前 ID 往前的 8 个位置
      const potentialIds = [];
      for (let i = -7; i <= 0; i++) {
        potentialIds.push(messageId + i);
      }

      // 🛠️ 尝试批量复制这个连续区间
      const batchCopyResp = await fetch(`${TELEGRAM_API}/copyMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          from_chat_id: CHANNEL_ID,
          message_ids: potentialIds
        })
      });
      
      const batchCopyResult = await batchCopyResp.json();

      // 🧹 只要这次批量复制成功吐出了聚拢的相册，立刻把整个历史区间原消息连根拔起全部删除！
      if (batchCopyResult.ok && batchCopyResult.result && batchCopyResult.result.length > 0) {
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

    // --- 普通单张图、单条文字或单视频 ---
    // 普通消息不需要等，直接原子化走完“复制 -> 删除”
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
    console.error('频道内时间差洗稿层发生异常:', error);
  }
}
