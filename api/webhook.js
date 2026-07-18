export default async function handler(req, res) {
  // 1. 第一时间返回 200，防止 Telegram Webhook 堵塞
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    const { channel_post } = req.body || {};
    if (!channel_post) return;

    // 从 Vercel 环境变量中读取配置
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;     
    const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN; 

    // 安全检查：直接强制转换为去空格的字符串比对
    const chatIdStr = String(channel_post.chat.id).trim();
    const targetChannelIdStr = String(CHANNEL_ID).trim();

    if (chatIdStr !== targetChannelIdStr) return;
    
    // 防死循环：如果消息绝对是由本机器人发出时才拦截
    if (channel_post.from && String(channel_post.from.id) === String(BOT_TOKEN.split(':')[0])) {
      return;
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
      return;
    }

    // ========================================================
    // 场景 B：媒体组多图相册并发（包含 media_group_id）
    // ========================================================
    const listKey = `mg:${mediaGroupId}`;
    const lockKey = `lock:${mediaGroupId}`;

    // 1. 将当前图片/视频的 message_id 推入 Redis
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['RPUSH', listKey, String(messageId)]);
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['EXPIRE', listKey, '10']);

    // 2. 修正后的分布式锁竞争：兼容 Upstash REST 返回 "OK" 或 true 的情况
    const setLock = await redisFetch(REDIS_URL, REDIS_TOKEN, ['SET', lockKey, 'processing', 'EX', '5', 'NX']);
    
    // 只有明确拿到结果且结果不为 OK 且不为 true 时，才断定抢锁失败
    if (!setLock || (setLock !== 'OK' && setLock !== true)) {
      return;
    }

    // 3. 原地等待 1.3 秒，让其他实例把 ID 都写完
    await new Promise(resolve => setTimeout(resolve, 1300));

    // 4. 从 Redis 中撈出所有 message_id
    const allIds = await redisFetch(REDIS_URL, REDIS_TOKEN, ['LRANGE', listKey, '0', '-1']);
    
    if (!allIds || allIds.length === 0) return;

    // 排序以防乱序
    const sortedIds = allIds.map(Number).sort((a, b) => a - b);

    // 5. 使用 forwardMessages 转发多图
    const forwardGroupResp = await fetch(`${TELEGRAM_API}/forwardMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: targetChannelIdStr,
        from_chat_id: targetChannelIdStr,
        message_ids: sortedIds
      })
    });
    const forwardGroupResult = await forwardGroupResp.json();

    // 6. 转发成功后批量删除原媒体组
    if (forwardGroupResult.ok) {
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

  } catch (error) {
    console.error('Webhook Error:', error);
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
