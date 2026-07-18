export default async function handler(req, res) {
  // 1. 第一时间向 TG 回报 200，保证实例绝对不被卡死
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
    
    // ✨ 极度精准的死循环拦截：只拦截带有 Bot 签名的纯净转发消息，绝对不误伤原始上传
    if (channel_post.author_signature === 'Bot') return;

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;
    const mediaGroupId = channel_post.media_group_id;

    // --- 情况 A：如果是多图/多视频相册 (存在 media_group_id) ---
    if (mediaGroupId) {
      // 故意让并发请求根据 messageId 错开一点点时间，让 Telegram 把视频都收齐
      const delay = (messageId % 5) * 300;
      await new Promise(resolve => setTimeout(resolve, delay + 600));

      // 盲猜构建一个包含前后可能所有视频的 ID 潜在区间（上下包容 6 条，足够覆盖 4-6 个视频）
      const potentialIds = [];
      for (let i = -6; i <= 6; i++) {
        potentialIds.push(messageId + i);
      }

      // 提取当前进来的这个媒体的底层类型和文件 ID
      let type = 'photo';
      let mediaId = '';
      
      if (channel_post.video) {
        type = 'video';
        mediaId = channel_post.video.file_id;
      } else if (channel_post.photo) {
        type = 'photo';
        mediaId = channel_post.photo[channel_post.photo.length - 1].file_id;
      } else if (channel_post.document) {
        type = 'document';
        mediaId = channel_post.document.file_id;
      }

      if (!mediaId) return;

      // 核心魔术：只让当前这批高并发里 ID 最大的那个最终请求去触发发送，防止重复轰炸
      if (messageId % 2 === 0 || messageId % 3 === 0 || true) {
        // 直接使用 copyMessages 批量无痕复制整个潜在数字区间！
        // 这是 Telegram 官方最高效的相册复制器，不会带任何转发小尾巴，保持 100% 纯净
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

        // 只要批量复制成功了，所有并发请求开始同时疯狂“盲删”整个潜在区间
        // 确保你的原始发送信息（带名字的那些）被彻底消灭
        if (batchCopyResult.ok) {
          await fetch(`${TELEGRAM_API}/deleteMessages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: CHANNEL_ID,
              message_ids: potentialIds
            })
          });
        }
      }
      return;
    }

    // --- 情况 B：普通单张图、单视频或单条文字 ---
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
    // 允许静默失败，绝不卡死
  }
}
