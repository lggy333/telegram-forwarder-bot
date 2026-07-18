// 简单的内存防抖，在实例存活时辅助合并
let lastMediaGroupId = null;
let pendingMessages = [];
let mediaTimer = null;

// 封装一个等待函数
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

    // --- 情况 A：如果是多图/相册 (存在 media_group_id) ---
    if (mediaGroupId) {
      // 如果是一组新相册，或者上一个相册已经处理完了，重新初始化收集队列
      if (lastMediaGroupId !== mediaGroupId) {
        lastMediaGroupId = mediaGroupId;
        pendingMessages = [];
      }

      pendingMessages.push(messageId);

      // 关键核心：我们不马上结束请求，而是卡在这里等待 1 秒钟，让 Telegram 把同组的其它图片并发送进来
      await sleep(1000);

      // 去重并排序，确保只由这组图的“最后那张图触发的请求”来统一执行复制和删除
      const currentIds = [...new Set(pendingMessages)].sort((a, b) => a - b);
      
      // 只有当前请求收集到的 ID 数量等于或接近最新收集的数量时，才代表它是最后一个到位的并发请求
      if (messageId === currentIds[currentIds.length - 1]) {
        // 1. 批量无痕复制相册
        const batchCopyResp = await fetch(`${TELEGRAM_API}/copyMessages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHANNEL_ID,
            from_chat_id: CHANNEL_ID,
            message_ids: currentIds
          })
        });
        const batchCopyResult = await batchCopyResp.json();

        // 2. 批量强行抹除原相册（整个生命周期在 Vercel 实例被掐死前闭环完成）
        if (batchCopyResult.ok) {
          await fetch(`${TELEGRAM_API}/deleteMessages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: CHANNEL_ID,
              message_ids: currentIds
            })
          });
        }
        
        // 释放标记
        lastMediaGroupId = null;
        pendingMessages = [];
      }

      return res.status(200).send('OK');
    }

    // --- 情况 B：普通单张图或单条文字 ---
    // 同样，先执行完完整的“复制 -> 删除”流程，最后再向 TG 汇报 200，绝不提早收工
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
    console.error('运行期发生致命拦截:', error);
  }

  return res.status(200).send('OK');
}
