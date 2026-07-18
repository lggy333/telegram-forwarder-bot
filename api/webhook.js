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
    const countKey = `cnt:${mediaGroupId}`;

    // 1. 将当前图片的 message_id 存入列表
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['RPUSH', listKey, String(messageId)]);
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['EXPIRE', listKey, '20']);

    // 2. 核心改变：利用计数器记录当前媒体组收到了几张图
    const currentCount = await redisFetch(REDIS_URL, REDIS_TOKEN, ['INCR', countKey]);
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['EXPIRE', countKey, '20']);

    console.log(`📸 图片 [${messageId}] 已入库，当前计数器累计收到图片数: ${currentCount}`);

    // 3. 原地假死 2.2 秒，给后续所有并发的图片实例留出充足的写入时间
    await new Promise(resolve => setTimeout(resolve, 2200));

    // 4. 等待结束后，再次去 Redis 查询这个相册最终的总图片数
    const finalCount = await redisFetch(REDIS_URL, REDIS_TOKEN, ['GET', countKey]);

    // 5. 兜底判定：如果最终总数大于我当时写入时的数量，说明我不是最后一张图的实例，直接退出！
    // 这样可以确保在全球高并发下，只有代表“最后一张图”的那个实例会留下来执行发送，其余全部静默释放
    if (Number(finalCount) !== Number(currentCount)) {
      console.log(`🔒 判定：当前实例对应的计数 (${currentCount}) 不是最终总数 (${finalCount})，交由后续实例处理，退出。`);
      return res.status(200).send('Sub-instance redundant');
    }

    // 6. 留下的唯一“天选实例”开始收割，捞出 Redis 里攒下的所有 ID
    const allIds = await redisFetch(REDIS_URL, REDIS_TOKEN, ['LRANGE', listKey, '0', '-1']);
    if (!allIds || allIds.length === 0) {
      return res.status(200).send('No IDs found');
    }

    // 去重并严格升序排序
    const sortedIds = [...new Set(allIds.map(Number))].sort((a, b) => a - b);
    console.log('🏆 成功集结全部图片，开始聚合无痕复制，ID 队列:', sortedIds);

    // 7. 调用 copyMessages 实现无痕复制（无来源标签，保持Caption）
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
    console.log('Telegram 聚合复制响应结果:', copyGroupResult);

    // 8. 成功后批量抹除原图
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

    // 9. 善后清理
    await redisFetch(REDIS_URL, REDIS_TOKEN, ['DEL', listKey, countKey]);
    return res.status(200).send('Main bundle masterfully executed');

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
