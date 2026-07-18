export default async function handler(req, res) {
  // 1. 第一时间给 TG 回应 200，保证通道绝对不堵塞
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    const { channel_post } = req.body || {};
    if (!channel_post) return;

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const ADMIN_ID = process.env.ADMIN_ID; // 你的个人 TG 数字 ID，作为无痕中转站

    const chatId = channel_post.chat.id;

    // 严格限制频道，并防止死循环
    if (String(chatId) !== String(CHANNEL_ID)) return;
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
      return;
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;
    const mediaGroupId = channel_post.media_group_id;

    // --- 情况 A：如果是多图/多视频相册 ---
    if (mediaGroupId) {
      // 🏎️ 阶梯式睡眠：ID 越大（最后的视频）等得越久，确保频道里的视频全部传完
      const suffix = messageId % 10;
      const delay = suffix * 350 + 1500; 
      await new Promise(resolve => setTimeout(resolve, delay));

      // 🔍 盲抓你刚才在频道里发送的原视频 ID 区间（向前覆盖 8 个 ID）
      const channelPotentialIds = [];
      for (let i = -7; i <= 0; i++) {
        channelPotentialIds.push(messageId + i);
      }

      // 🚀 【核心步骤 1】：把频道里的视频“整团批量转发”到私聊。
      // 只有 forwardMessages 批量转发能 100% 逼迫 TG 在私聊里把它黏回成相册！
      const forwardToBufferResp = await fetch(`${TELEGRAM_API}/forwardMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_ID,
          from_chat_id: CHANNEL_ID,
          message_ids: channelPotentialIds
        })
      });
      
      const forwardResult = await forwardToBufferResp.json();

      // 如果批量转发成功，说明私聊里已经躺着聚拢好的完美相册了
      if (forwardResult.ok && forwardResult.result && forwardResult.result.length > 0) {
        // 拿到私聊里新生成的相册消息 ID 列表
        const bufferedMessageIds = forwardResult.result.map(r => r.message_id);

        // 🚀 【核心步骤 2】：把私聊里黏好的完美相册，用 copyMessages 批量无痕复制回频道！
        // 跨聊天框批量 copy，在频道里同样 100% 是完美相册，且成功洗掉转发小尾巴！
        const copyBackResp = await fetch(`${TELEGRAM_API}/copyMessages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHANNEL_ID,
            from_chat_id: ADMIN_ID,
            message_ids: bufferedMessageIds
          })
        });
        const copyBackResult = await copyBackResp.json();

        // 🧹 【核心步骤 3】：洗稿成功！斩草除根，两边全部盲删
        if (copyBackResult.ok) {
          // 彻底抹除频道里带你名字的原始视频
          await fetch(`${TELEGRAM_API}/deleteMessages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: CHANNEL_ID,
              message_ids: channelPotentialIds
            })
          });

          // 彻底抹除私聊缓冲区里的中转垃圾
          await fetch(`${TELEGRAM_API}/deleteMessages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: ADMIN_ID,
              message_ids: bufferedMessageIds
            })
          });
        }
      }
      return;
    }

    // --- 情况 B：普通的单文本或单张图 ---
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
    console.error('完美洗稿流发生异常:', error);
  }
}
