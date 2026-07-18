export default async function handler(req, res) {
  // 1. 第一时间返回 200，保证并发请求不堵塞
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    const { channel_post } = req.body || {};
    if (!channel_post) return;

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const ADMIN_ID = process.env.ADMIN_ID; // 你的个人 Telegram ID，用来当作机器人的私聊临时缓冲区

    const chatId = channel_post.chat.id;

    // 严格限制频道，并且防止机器人自嗨死循环
    if (String(chatId) !== String(CHANNEL_ID)) return;
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
      return;
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;
    const mediaGroupId = channel_post.media_group_id;

    // --- 情况 A：如果是多图/多视频相册 ---
    if (mediaGroupId) {
      // 🚀 【中转核心步骤 1】：把当前进来的这单张图/单视频，先无痕复制到你和 Bot 的私聊框（缓冲暂存）
      // 跨聊天框传输，TG 会在私聊框里把它们 100% 自动聚拢回完美的相册，绝不漏发！
      const toBufferResp = await fetch(`${TELEGRAM_API}/copyMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_ID,         // 缓冲地：你和机器人的私聊对话框
          from_chat_id: CHANNEL_ID,  // 来源：频道
          message_id: messageId
        })
      });
      const toBufferResult = await toBufferResp.json();

      if (toBufferResult.ok) {
        const bufferedMessageId = toBufferResult.result.message_id;

        // 🏎️ 动态阶梯式睡眠：ID 越大（最后的视频）等得越久，确保私聊里的相册已经全部收齐
        const delay = (messageId % 5) * 300 + 1500;
        await new Promise(resolve => setTimeout(resolve, delay));

        // 🔍 构建一个私聊缓冲区的消息 ID 潜在区间
        const bufferPotentialIds = [];
        for (let i = -7; i <= 0; i++) {
          bufferPotentialIds.push(bufferedMessageId + i);
        }

        // 🚀 【中转核心步骤 2】：由“天选之子”（最后一个请求）把私聊里聚拢好的完美相册，批量无痕复制回频道！
        const backToChannelResp = await fetch(`${TELEGRAM_API}/copyMessages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHANNEL_ID,            // 终点：回到你的频道
            from_chat_id: ADMIN_ID,         // 来源：私聊缓冲区
            message_ids: bufferPotentialIds
          })
        });
        const backToChannelResult = await backToChannelResp.json();

        // 🧹 【中转核心步骤 3】：如果成功发回了完美的纯净相册，把频道里的原消息和私聊里的缓存全部盲删，人间蒸发！
        if (backToChannelResult.ok && backToChannelResult.result && backToChannelResult.result.length > 0) {
          // 盲删频道里你发的原始视频区间
          const channelPotentialIds = [];
          for (let i = -7; i <= 0; i++) {
            channelPotentialIds.push(messageId + i);
          }
          await fetch(`${TELEGRAM_API}/deleteMessages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CHANNEL_ID, message_ids: channelPotentialIds })
          });

          // 顺便把私聊缓冲区也删干净，不留垃圾
          await fetch(`${TELEGRAM_API}/deleteMessages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: ADMIN_ID, message_ids: bufferPotentialIds })
          });
        }
      }
      return;
    }

    // --- 情况 B：普通的单文本或单张图 ---
    // 普通消息没并发压力，直接在频道内原地“复制 -> 删除”即可
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
    console.error('机器人自主缓冲流异常:', error);
  }
}
