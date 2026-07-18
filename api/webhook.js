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

    // --- 核心步骤一：原子化复制 ---
    const copyUrl = `${TELEGRAM_API}/copyMessage`;
    const copyBody = {
      chat_id: CHANNEL_ID,
      from_chat_id: CHANNEL_ID,
      message_id: messageId
    };

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
      console.error('[复制失败网络/系统级异常]:', copyRes);
      
      // 如果是频繁触发限流，或者 Telegram 服务器 5xx / 请求超时
      // 故意向 Telegram 返回 429 或 500 状态码，Telegram 发现非 200 后会自动延时重新投递该 Webhook，确保消息不漏
      if (copyRes.isRateLimit) return res.status(429).send('Too Many Requests');
      if (copyRes.isTimeout || copyRes.httpStatus >= 500) return res.status(500).send('Telegram Server Error');
      
      // 如果是 400 错误（例如原消息已经被手动删了），重试也无用，直接返回 200 丢弃
      return res.status(200).send('OK');
    }

    if (!copyRes.data?.ok) {
      console.error('[复制失败业务级异常]:', copyRes.data);
      // 业务逻辑错误（例如 403 无权限），返回 200 终止，避免死循环重试
      if (copyRes.data?.error_code === 400) return res.status(200).send('OK');
      return res.status(500).send('Copy Business Logic Error');
    }

    // --- 核心步骤二：严格紧跟删除 ---
    // 运行到这里，说明复制已经绝对成功。接下来的删除动作必须极其小心，不能因为删除失败而导致整条消息被 Telegram 重投。
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

    // 如果删除因为偶发网络抖动失败，做最后一次原地的“死等重试”挽救
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
    // 全局未知代码崩溃时，保险起见返回 200，防止引起不必要的 Telegram 疯狂重投死循环
    return res.status(200).send('OK');
  }

  // 无论删除最终是否彻底成功，由于【复制已成功】，必须返回 200 结束流程，防止多胞胎重复消息
  return res.status(200).send('OK');
}
