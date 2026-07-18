export default async function handler(req, res) {
  try {
    const { channel_post } = req.body || {};
    if (!channel_post || !channel_post.media_group_id) {
      // 非媒体组消息：直接常规复制
      return await handleSingleMessage(req, res, channel_post);
    }

    const { BOT_TOKEN, CHANNEL_ID, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
    const mediaGroupId = channel_post.media_group_id;
    const listKey = `mg:${mediaGroupId}`;
    const lastCheckKey = `last:${mediaGroupId}`;

    // 1. 入库
    await redisFetch(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['RPUSH', listKey, String(channel_post.message_id)]);
    await redisFetch(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['EXPIRE', listKey, '30']);
    
    // 2. 存入当前时间戳，作为“最后活跃标记”
    const now = Date.now();
    await redisFetch(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['SET', lastCheckKey, now]);

    // 3. 异步等待 3 秒（这里不阻塞 HTTP，只通过逻辑判断）
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 4. 检查：如果在 3 秒后，该 key 的时间戳没变，说明这是最后一张图
    const lastCheck = await redisFetch(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['GET', lastCheckKey]);
    if (Number(lastCheck) !== now) {
      return res.status(200).send('Still receiving');
    }

    // 5. 最终收割：只有最后进来的实例执行
    const allIds = await redisFetch(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['LRANGE', listKey, '0', '-1']);
    const sortedIds = [...new Set(allIds.map(Number))].sort((a, b) => a - b);

    // 调用 API 聚合
    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const copyResp = await fetch(`${TELEGRAM_API}/copyMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHANNEL_ID, from_chat_id: CHANNEL_ID, message_ids: sortedIds, remove_caption: false })
    });
    
    if ((await copyResp.json()).ok) {
      await fetch(`${TELEGRAM_API}/deleteMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHANNEL_ID, message_ids: sortedIds })
      });
    }

    await redisFetch(UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, ['DEL', listKey, lastCheckKey]);
    return res.status(200).send('Bundle Success');

  } catch (e) { return res.status(500).send('Err'); }
}

async function handleSingleMessage(req, res, msg) { /* 单条逻辑同之前 */ }
async function redisFetch(url, token, command) { /* 同之前 */ }
