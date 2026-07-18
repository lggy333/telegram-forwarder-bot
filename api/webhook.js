export default async function handler(req, res) {
  // 1. 第一时间返回 200，防止 Telegram Webhook 因延迟超时而反复重试和堵塞
  res.status(200).send('OK');

  try {
    if (req.method !== 'POST') return;

    const { channel_post } = req.body || {};
    if (!channel_post) return;

    // 从 Vercel 环境变量中读取配置
    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;     // 你的 Upstash Redis URL
    const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN; // 你的 Upstash Redis Token

    const chatId = channel_post.chat.id;

    // 安全检查：只处理目标频道，且忽略机器人发出的消息，防止无限死循环
    if (String(chatId) !== String(CHANNEL_ID)) return;
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
      return;
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;
    const mediaGroupId = channel_post.media_group_id;

    // ========================================================
    // 场景 A：单图 或 纯文字 消息（没有 media_group_id）
    // ========================================================
    if (!mediaGroupId) {
      // 使用单数版 copyMessage 无痕复制
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

      // 如果复制成功，立刻删除原消息
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
      return; // 单图处理完毕，直接退出
    }

    // ========================================================
    // 场景 B：媒体组多图相册并发（包含 media_group_id）
    // ========================================================
    const listKey = `mg:${mediaGroupId}`;
    const lockKey = `lock:${mediaGroupId}`;

    // 1. 原子化操作：将当前图片/视频的 message_id 推入 Redis 列表中
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['RPUSH', listKey, String(messageId)]);
    // 为列表设置 10 秒过期时间，防止因极端异常导致数据残留堵塞容量
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['EXPIRE', listKey, '10']);

    // 2. 分布式锁竞争：尝试抢占该媒体组的“处理官”名额（SETNX 占位 5 秒）
    const setLock = await redisFetch(REDIS_URL, REDIS_TOKEN, ['SET', lockKey, 'processing', 'EX', '5', 'NX']);
    
    // 如果返回的不是 "OK"，说明当前 Serverless 实例不是第一个到的，直接退出，让抢到锁的实例去聚合处理
    if (setLock !== 'OK') {
      return;
    }

    // 3. 作为“处理官”的实例，原地假死等待 1.3 秒，给其他并发的图片实例留出充足的时间将 ID 写入 Redis
    await new Promise(resolve => setTimeout(resolve, 1300));

    // 4. 从 Redis 中一次性捞出所有并发攒下的 message_id
    const allIds = await redisFetch(REDIS_URL, REDIS_TOKEN, ['LRANGE', listKey, '0', '-1']);
    
    if (!allIds || allIds.length === 0) return;

    // 核心步骤：将提取出的 ID 进行升序排序。防止因网络波动导致相册内的图片顺序错乱颠倒
    const sortedIds = allIds.map(Number).sort((a, b) => a - b);

    // 5. 调用 Telegram 官方复数版 API —— copyMessages 完美聚合无痕复制
    const copyGroupResp = await fetch(`${TELEGRAM_API}/copyMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        from_chat_id: CHANNEL_ID,
        message_ids: sortedIds // 传入数组，例如 [1001, 1002, 1003]
      })
    });
    const copyGroupResult = await copyGroupResp.json();

    // 6. 如果聚合复制成功，调用复数版 deleteMessages 批量干净抹除原媒体组
    if (copyGroupResult.ok) {
      await fetch(`${TELEGRAM_API}/deleteMessages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          message_ids: sortedIds
        })
      });
    }

    // 7. 善后处理：主动释放并删除 Redis 中的缓存与分布式锁
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['DEL', listKey, lockKey]);

  } catch (error) {
    console.error('Webhook Error:', error);
  }
}

/**
 * 封装的轻量级 Upstash REST API 请求工具
 * 无需引入任何额外的 npm 依赖包，完全基于原生 fetch 运行
 */
async function redisFetch(url, token, command) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(command)
    });
    const data = await res.json();
    return data.result;
  } catch (e) {
    console.error('Redis Error:', e);
    return null;
  }
}
