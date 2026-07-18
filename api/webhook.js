export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(200).send('Not POST');
    }

    const { channel_post } = req.body || {};
    if (!channel_post) {
      return res.status(200).send('No channel_post');
    }

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;     
    const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN; 

    const chatIdStr = String(channel_post.chat.id).trim();
    const targetChannelIdStr = CHANNEL_ID ? String(CHANNEL_ID).trim() : '';

    if (chatIdStr !== targetChannelIdStr) {
      return res.status(200).send('ID mismatch');
    }
    
    // 防死循环
    if (channel_post.from && String(channel_post.from.id) === String(BOT_TOKEN.split(':')[0])) {
      return res.status(200).send('Self message');
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;
    const mediaGroupId = channel_post.media_group_id;

    // ========================================================
    // 场景 A：单图 或 纯文字 消息（没有 media_group_id）
    // ========================================================
    if (!mediaGroupId) {
      const copyResponse = await fetch(`${TELEGRAM_API}/copyMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChannelIdStr,
          from_chat_id: targetChannelIdStr,
          message_id: messageId
        })
      });
      const copyResult = await copyResponse.json();

      if (copyResult.ok) {
        await fetch(`${TELEGRAM_API}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: targetChannelIdStr,
            message_id: messageId
          })
        });
      }
      return res.status(200).send('Single message processed');
    }

    // ========================================================
    // 场景 B：媒体组多图相册并发（包含 media_group_id）
    // ========================================================
    const listKey = `mg:${mediaGroupId}`;
    const lockKey = `lock:${mediaGroupId}`;

    // 1. 将当前图片/视频的 message_id 推入 Redis
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['RPUSH', listKey, String(messageId)]);
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['EXPIRE', listKey, '15']);

    // 2. 分布式锁竞争
    const setLock = await redisFetch(REDIS_URL, REDIS_TOKEN, ['SET', lockKey, 'processing', 'EX', '8', 'NX']);
    
    if (!setLock || (setLock !== 'OK' && setLock !== true)) {
      return res.status(200).send('Sub-instance locked');
    }

    // 3. 强力防抖：将等待时间延长至 2.0 秒，确保极端网络下所有图片的 ID 均已成功入库
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 4. 从 Redis 中撈出所有被聚合的 message_id
    const allIds = await redisFetch(REDIS_URL, REDIS_TOKEN, ['LRANGE', listKey, '0', '-1']);
    
    if (!allIds || allIds.length === 0) {
      return res.status(200).send('No IDs found');
    }

    // 严格按 ID 升序排序，保证相册顺序不颠倒
    const sortedIds = [...new Set(allIds.map(Number))].sort((a, b) => a - b);

    console.log('🚀 准备聚合复制的 ID 队列:', sortedIds);

    // 5. 换回 copyMessages（复数复制版）以彻底去掉“转发来源”标签
    // 关键：传入 remove_caption: false 保持你原本写好的图注不丢失
    const copyGroupResp = await fetch(`${TELEGRAM_API}/copyMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChannelIdStr,
        from_chat_id: targetChannelIdStr,
        message_ids: sortedIds,
        remove_caption: false
      })
    });
    const copyGroupResult = await copyGroupResp.json();
    console.log('Telegram 聚合复制结果:', copyGroupResult);

    // 6. 复制成功后批量干净抹除原媒体组
    if (copyGroupResult.ok) {
      await fetch(`${TELEGRAM_API}/deleteMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChannelIdStr,
          message_ids: sortedIds
        })
      });
    }

    // 7. 清理缓存
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['DEL', listKey, lockKey]);
    
    return res.status(200).send('Main instance masterfully processed');

  } catch (error) {
    console.error('Webhook Error:', error);
    return res.status(500).send('Internal Error');
  }
}

async function redisFetch(url, token, command) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command)
    });
    const data = await res.json();
    return data.result;
  } catch (e) {
    console.error('Redis Error:', e);
    return null;
  }
}
