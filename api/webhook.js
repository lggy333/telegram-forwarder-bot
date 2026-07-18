export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(200).send('Not POST');
    }

    const { channel_post } = req.body || {};
    if (!channel_post) {
      return res.status(200).send('No channel_post');
    }

    // 从 Vercel 环境变量中读取配置
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;     
    const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN; 

    // 强力去空格转换
    const chatIdStr = String(channel_post.chat.id).trim();
    const targetChannelIdStr = CHANNEL_ID ? String(CHANNEL_ID).trim() : '';

    console.log(`🔍 [ID比对检查] 当前收到频道ID: "${chatIdStr}" | 环境变量配置ID: "${targetChannelIdStr}"`);

    if (chatIdStr !== targetChannelIdStr) {
      console.log('❌ 匹配失败：当前频道 ID 与环境变量不一致，安全拦截退出。');
      return res.status(200).send('ID mismatch');
    }
    
    // 防死循环
    if (channel_post.from && String(channel_post.from.id) === String(BOT_TOKEN.split(':')[0])) {
      console.log('❌ 拦截：此消息由机器人自身发出，防止死循环。');
      return res.status(200).send('Self message');
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;
    const mediaGroupId = channel_post.media_group_id;

    // ========================================================
    // 场景 A：单图 或 纯文字 消息（没有 media_group_id）
    // ========================================================
    if (!mediaGroupId) {
      console.log('📝 检测到单图或纯文本，直接调用 copyMessage...');
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
      console.log('单图 copyMessage 结果:', copyResult);

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

    console.log(`📸 检测到媒体组相册，ID: ${mediaGroupId}，开始写入 Redis...`);
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['RPUSH', listKey, String(messageId)]);
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['EXPIRE', listKey, '10']);

    const setLock = await redisFetch(REDIS_URL, REDIS_TOKEN, ['SET', lockKey, 'processing', 'EX', '5', 'NX']);
    console.log(`加锁尝试结果:`, setLock);
    
    if (!setLock || (setLock !== 'OK' && setLock !== true)) {
      console.log('🔒 抢锁失败，由其他并发实例处理，当前实例退出。');
      // 没抢到锁的实例也要安全返回，它们已经完成了写入任务
      return res.status(200).send('Sub-instance locked');
    }

    console.log('🏆 抢锁成功！作为处理官，等待 1.3 秒聚合图片...');
    await new Promise(resolve => setTimeout(resolve, 1300));

    const allIds = await redisFetch(REDIS_URL, REDIS_TOKEN, ['LRANGE', listKey, '0', '-1']);
    console.log('从 Redis 读取到的所有图片 ID:', allIds);
    
    if (!allIds || allIds.length === 0) {
      return res.status(200).send('No IDs found');
    }

    const sortedIds = allIds.map(Number).sort((a, b) => a - b);

    console.log('🚀 开始向 Telegram 发送 forwardMessages 请求...');
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
    console.log('Telegram 转发结果:', forwardGroupResult);

    if (forwardGroupResult.ok) {
      console.log('🗑️ 转发成功，开始批量删除原消息...');
      await fetch(`${TELEGRAM_API}/deleteMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: targetChannelIdStr,
          message_ids: sortedIds
        })
      });
    }

    await redisFetch(REDIS_URL, REDIS_TOKEN, ['DEL', listKey, lockKey]);
    
    // 所有任务安全结束后，由主处理官发送最后的 200 OK
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
