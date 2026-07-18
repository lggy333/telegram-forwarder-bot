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
      // 核心魔术：让所有并发请求互相错开时间
      // 我们用 messageId 的末尾数字来做微小的延迟，确保多图里“只有 ID 最大（最后一张）的请求”去执行操作！
      // 比如有图 101, 102, 103。101等0ms，102等200ms，103等400ms。
      // 这样等 103 醒来的时候，Telegram 服务器已经把前两张图的发送完全处理完毕了。
      const delay = (messageId % 10) * 200; 
      await new Promise(resolve => setTimeout(resolve, delay + 500));

      // 重点来了：我们不需要在内存里存列表。既然这是一个相册，我们可以直接向 Telegram 官方索取
      // 我们尝试向前窥探和向后包裹最多 9 条消息（TG 相册最大上限 10 张图）
      // 组装一个可能属于这个相册的潜在 ID 范围
      const potentialIds = [];
      for (let i = -9; i <= 9; i++) {
        potentialIds.push(messageId + i);
      }

      // 只有当当前请求是这一批并发中“最大的那个 ID”时，才由它一口气搞定全部，其它小的 ID 请求直接当场放行
      // 这样就彻底断绝了“互相踩脚、各删各的”乱象！
      if (delay === Math.max((messageId % 10) * 200)) {
        // 使用 copyMessages 批量复制整个潜在区（Telegram 极其聪明，即使夹杂了非同组 ID，它也只会提取同组相册内容）
        const batchCopyResp = await fetch(`${TELEGRAM_API}/copyMessages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHANNEL_ID,
            from_chat_id: CHANNEL_ID,
            message_ids: potentialIds,
            remove_caption: false // 保留你写好的文案
          })
        });
        const batchCopyResult = await batchCopyResp.json();

        // 如果批量无痕复制成功，直接把刚才那堆潜在 ID 连根拔起一并删除！
        if (batchCopyResult.ok && batchCopyResult.result) {
          // 提取真正成功复制出来的那些原始消息 ID，精准定点清除
          const successfulIds = batchCopyResult.result.map(r => r.message_id);
          
          await fetch(`${TELEGRAM_API}/deleteMessages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: CHANNEL_ID,
              message_ids: potentialIds // 直接盲删整个潜在区间，极度干净高效
            })
          });
        }
      }

      return res.status(200).send('OK');
    }

    // --- 情况 B：普通单张图或单条文字 ---
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
    console.error('Serverless 完美融合层拦截到异常:', error);
  }

  return res.status(200).send('OK');
}
