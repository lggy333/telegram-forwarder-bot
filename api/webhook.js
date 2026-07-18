export default async function handler(req, res) {
  // 1. 快速响应，确保 Telegram 认为已接收
  res.status(200).send('OK');

  const { channel_post } = req.body || {};
  if (!channel_post) return;

  const { BOT_TOKEN, CHANNEL_ID, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  const listKey = `mg:${channel_post.media_group_id}`;
  
  // 2. 存入 ID 并设置过期时间（1 分钟）
  await redisFetch(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['RPUSH', listKey, String(channel_post.message_id)]);
  await redisFetch(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['EXPIRE', listKey, '60']);

  // 3. 统计当前相册 ID 数量
  const allIds = await redisFetch(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['LRANGE', listKey, '0', '-1']);
  
  // 4. 重点：只有当 ID 数量达到预期（例如 3 张或更多）才触发发送
  // 或者你也可以根据固定延迟触发。这里用最暴力的：凑够 3 张才处理
  if (allIds && allIds.length >= 3) {
    const sortedIds = [...new Set(allIds.map(Number))].sort((a, b) => a - b);
    
    // 执行发送
    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const resp = await fetch(`${TELEGRAM_API}/copyMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHANNEL_ID, from_chat_id: CHANNEL_ID, message_ids: sortedIds, remove_caption: false })
    });
    
    if ((await resp.json()).ok) {
      await fetch(`${TELEGRAM_API}/deleteMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHANNEL_ID, message_ids: sortedIds })
      });
      // 成功后清理列表
      await redisFetch(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['DEL', listKey]);
    }
  }
}

async function redisFetch(url, token, command) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  return (await res.json()).result;
}
