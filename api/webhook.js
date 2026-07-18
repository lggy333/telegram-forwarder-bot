/**
 * 辅助函数：具备超时控制和状态解析的精细化 Fetch
 */
async function telegramFetch(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);

    // 针对 Telegram 全局 429 限流做特殊标记
    if (response.status === 429) {
      const errorData = await response.json().catch(() => ({}));
      return { 
        ok: false, 
        isRateLimit: true, 
        retryAfter: errorData.parameters?.retry_after || 2 
      };
    }

    if (!response.ok) {
      return { ok: false, httpStatus: response.status };
    }

    const data = await response.json();
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timeoutId);
    return { 
      ok: false, 
      isTimeout: err.name === 'AbortError', 
      error: err 
    };
  }
}

export default async function handler(req, res) {
  // 1. 基础安全过滤
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

    if (!BOT_TOKEN || !CHANNEL_ID) {
      console.error('[配置错误] 缺少必要的环境变量 BOT_TOKEN 或 CHANNEL_ID');
      return res.status(500).send('Configuration Error');
    }

    // 严格限制频道与机器人自身，防止死循环
    if (String(channel_post.chat.id) !== String(CHANNEL_ID)) return res.status(200).send('OK');
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
      return res.status(200).send('OK');
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;

    // --- 核心步骤一：判定类型并动态构建请求（去模糊核心） ---
    let copyUrl = `${TELEGRAM_API}/copyMessage`;
    let copyBody = {
      chat_id: CHANNEL_ID,
      from_chat_id: CHANNEL_ID,
      message_id: messageId
    };

    // 如果包含视频、图片或动图，放弃 copyMessage，改用专属 send 接口并强行设置 has_spoiler: false
    if (channel_post.video) {
      copyUrl = `${TELEGRAM_API}/sendVideo`;
      copyBody = {
        chat_id: CHANNEL_ID,
        video: channel_post.video.file_id,
        caption: channel_post.caption || '',
        caption_entities: channel_post.caption_entities, // 保留原文本样式（加粗、链接等）
        has_spoiler: false
      };
    } else if (channel_post.photo) {
      copyUrl = `${TELEGRAM_API}/sendPhoto`;
      const photoArray = channel_post.photo;
      copyBody = {
        chat_id: CHANNEL_ID,
        photo: photoArray[photoArray.length - 1].file_id, // 取最高清的版本
        caption: channel_post.caption || '',
        caption_entities: channel_post.caption_entities,
        has_spoiler: false
      };
    } else if (channel_post.animation) {
      copyUrl = `${TELEGRAM_API}/sendAnimation`;
      copyBody = {
        chat_id: CHANNEL_ID,
        animation: channel_post.animation.file_id,
        caption: channel_post.caption || '',
        caption_entities: channel_post.caption_entities,
        has_spoiler: false
      };
    }

    let copyRes = await telegramFetch(copyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(copyBody)
    });

    //【高可用优化】如果复制请求被 Telegram 限流 (429)，且等待时间较短(<=3秒)，在当前实例内原地抗住并重试一次
    if (!copyRes.ok && copyRes.isRateLimit && copyRes.retryAfter <= 3) {
      console.warn(`[限流避让] 触发 429，原地等待 ${copyRes.retryAfter} 秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, copyRes.retryAfter * 1000));
      copyRes = await telegramFetch(copyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(copyBody)
      });
    }

    //【高可用决策点】评估复制结果
    if (!copyRes.ok) {
      console.error('[发送/复制失败网络/系统级异常]:', copyRes);
      if (copyRes.isRateLimit) return res.status(429).send('Too Many Requests');
      if (copyRes.isTimeout || copyRes.httpStatus >= 500) return res.status(500).send('Telegram Server Error');
      return res.status(200).send('OK');
    }

    if (!copyRes.data?.ok) {
      console.error('[发送/复制失败业务级异常]:', copyRes.data);
      if (copyRes.data?.error_code === 400) return res.status(200).send('OK');
      return res.status(500).send('Copy Business Logic Error');
    }

    // --- 核心步骤二：严格紧跟删除 ---
    const deleteUrl = `${TELEGRAM_API}/deleteMessage`;
    const deleteBody = {
      chat_id: CHANNEL_ID,
      message_id: messageId
    };

    const deleteRes = await telegramFetch(deleteUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(deleteBody)
    });

    if (!deleteRes.ok && (deleteRes.isTimeout || deleteRes.isRateLimit)) {
      console.warn('[删除失败挽救] 网络抖动，1秒后进行最后一次定点删除尝试...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      await telegramFetch(deleteUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deleteBody)
      });
    }

  } catch (error) {
    console.error('[全局未捕获严重异常]:', error);
    return res.status(200).send('OK');
  }

  return res.status(200).send('OK');
}
