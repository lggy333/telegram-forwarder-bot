export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(200).send('Not POST');

    const { channel_post } = req.body || {};
    if (!channel_post) return res.status(200).send('No content');

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;     
    const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN; 

    // 严谨校验
    if (String(channel_post.chat.id).trim() !== String(CHANNEL_ID).trim()) return res.status(200).send('ID mismatch');
    
    // 基础过滤
    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;
    
    // 强制聚合核心逻辑：使用当前时间的前 3 秒作为 key，不管 ID 是什么，同一瞬间的全部强行聚在一起
    const timeWindow = Math.floor(Date.now() / 3000);
    const listKey = `win:${timeWindow}`;

    // 1. 入库
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['RPUSH', listKey, String(messageId)]);
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['EXPIRE', listKey, '10']);

    // 2. 原地等待 2.5 秒，让所有并发的图片全部落入这个时间窗口
    await new Promise(resolve => setTimeout(resolve, 2500));

    // 3. 只有当此时读取到的数据量 >= 之前统计的数据量时才处理（防重复触发）
    const allIds = await redisFetch(REDIS_URL, REDIS_TOKEN, ['LRANGE', listKey, '0', '-1']);
    const uniqueIds = [...new Set(allIds.map(Number))].sort((a, b) => a - b);
    
    // 4. 关键：只让“处理过一次”的标记位来决定执行权
    const lockKey = `lock:${timeWindow}`;
    const setLock = await redisFetch(REDIS_URL, REDIS_TOKEN, ['SET', lockKey, '1', 'EX', '10', 'NX']);
    
    if (!setLock || (setLock !== 'OK' && setLock !== true)) {
      return res.status(200).send('Waiting for master');
    }

    console.log('🏆 聚合处理队列:', uniqueIds);

    // 5. 聚合复制
    const copyGroupResp = await fetch(`${TELEGRAM_API}/copyMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        from_chat_id: CHANNEL_ID,
        message_ids: uniqueIds,
        remove_caption: false
      })
    });
    const result = await copyGroupResp.json();

    if (result.ok) {
      await fetch(`${TELEGRAM_API}/deleteMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          message_ids: uniqueIds
        })
      });
    }

    return res.status(200).send('Bundle success');

  } catch (error) {
    return res.status(500).send('Err');
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
  } catch (e) { return null; }
}
