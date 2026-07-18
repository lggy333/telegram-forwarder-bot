// 全局内存缓存，用于合并高并发的多图相册事件
let mediaGroupCache = {};

export default async function handler(req, res) {
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    const { channel_post } = req.body || {};
    if (!channel_post) return;

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const chatId = channel_post.chat.id;

    // 严格限制只处理目标频道，且忽略机器人自己发的，防止死循环
    if (String(chatId) !== String(CHANNEL_ID)) return;
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) return;

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;
    const mediaGroupId = channel_post.media_group_id;

    // --- 情况 A：如果是多图/媒体组 (Album) ---
    if (mediaGroupId) {
      if (!mediaGroupCache[mediaGroupId]) {
        mediaGroupCache[mediaGroupId] = {
          messageIds: [],
          timer: null
        };
      }

      // 将高并发进来的图片 ID 攒起来
      mediaGroupCache[mediaGroupId].messageIds.push(messageId);

      // 清除前一个定时器，触发“防抖合并”
      if (mediaGroupCache[mediaGroupId].timer) {
        clearTimeout(mediaGroupCache[mediaGroupId].timer);
      }

      // 等待 800 毫秒，确信这一批相册的图片全部进来了，再统一处理
      mediaGroupCache[mediaGroupId].timer = setTimeout(async () => {
        const idsToProcess = [...mediaGroupCache[mediaGroupId].messageIds].sort((a, b) => a - b);
        delete mediaGroupCache[mediaGroupId]; // 及时释放内存

        try {
          // 使用复数版 copyMessages，完美保留相册结构，不拆散
          const batchCopyResp = await fetch(`${TELEGRAM_API}/copyMessages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: CHANNEL_ID,
              from_chat_id: CHANNEL_ID,
              message_ids: idsToProcess
            })
          });
          const batchCopyResult = await batchCopyResp.json();

          // 批量复制成功后，批量斩草除根删除原相册
          if (batchCopyResult.ok) {
            await fetch(`${TELEGRAM_API}/deleteMessages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: CHANNEL_ID,
                message_ids: idsToProcess
              })
            });
          }
        } catch (err) {
          console.error('批量相册处理失败:', err);
        }
      }, 800);

      return;
    }

    // --- 情况 B：如果是普通的单张图或单条文字 ---
    try {
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
      console.error('单条消息处理失败:', error);
    }

  } catch (error) {
    console.error('全局捕获异常:', error);
  }
}
