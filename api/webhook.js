/**
 * 辅助函数：具备超时控制和状态解析的精细化 Fetch
 */
async function telegramFetch(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);

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

    if (String(channel_post.chat.id) !== String(CHANNEL_ID)) return res.status(200).send('OK');
    if (channel_post.author_signature === 'Bot' || (channel_post.from && channel_post.from.is_bot)) {
      return res.status(200).send('OK');
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;

    // --- 核心步骤一：深度媒体类型重映射（彻底去模糊） ---
    let method = 'copyMessage';
    let copyBody = {
      chat_id: CHANNEL_ID,
      from_chat_id: CHANNEL_ID,
      message_id: messageId
    };

    const caption = channel_post.caption || '';
    const caption_entities = channel_post.caption_entities || [];

    if (channel_post.video) {
      // 标准视频：切换为发送方法，不给 has_spoiler 赋值，默认不模糊
      method = 'sendVideo';
      copyBody = {
        chat_id: CHANNEL_ID,
        video: channel_post.video.file_id,
        caption,
        caption_entities
      };
    } else if (channel_post.photo) {
      // 标准图片
      method = 'sendPhoto';
      copyBody = {
        chat_id: CHANNEL_ID,
        photo: channel_post.photo[channel_post.photo.length - 1].file_id,
        caption,
        caption_entities
      };
    } else if (channel_post.animation) {
      // 动图 GIF
      method = 'sendAnimation';
      copyBody = {
        chat_id: CHANNEL_ID,
        animation: channel_post.animation.file_id,
        caption,
        caption_entities
      };
    } else if (channel_post.document) {
      // 【关键修复点】如果是以文件形式发送的媒体
      const mime = channel_post.document.mime_type || '';
      
      if (mime.startsWith('video/')) {
        // 如果文件本质是视频，强行转化为标准视频流发送，洗掉模糊状态
        method = 'sendVideo';
        copyBody = {
          chat_id: CHANNEL_ID,
          video: channel_post.document.file_id,
          caption,
          caption_entities
        };
      } else if (mime.startsWith('image/')) {
        // 如果文件本质是图片，强行转化为标准图片发送
        method = 'sendPhoto';
        copyBody = {
          chat_id: CHANNEL_ID,
          photo: channel_post.document.file_id,
          caption,
          caption_entities
        };
      } else {
        // 其他普通文件，改用 sendDocument 重新发送，脱离原消息的 copy 机制
        method = 'sendDocument';
        copyBody = {
          chat_id: CHANNEL_ID,
          document: channel_post.document.file_id,
          caption,
          caption_entities
        };
      }
    }

    const copyUrl = `${TELEGRAM_API}/${method}`;

    let copyRes = await telegramFetch(copyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(copyBody)
    });

    //【高可用优化】429 限流原地重试
    if (!copyRes.ok && copyRes.isRateLimit && copyRes.retryAfter <= 3) {
      console.warn(`[限流避让] 触发 429，原地等待 ${copyRes.retryAfter} 秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, copyRes.retryAfter * 1000));
      copyRes = await telegramFetch(copyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(copyBody)
      });
    }

    if (!copyRes.ok) {
      console.error('[发送失败网络/系统级异常]:', copyRes);
      if (copyRes.isRateLimit) return res.status(429).send('Too Many Requests');
      if (copyRes.isTimeout || copyRes.httpStatus >= 500) return res.status(500).send('Telegram Server Error');
      return res.status(200).send('OK');
    }

    if (!copyRes.data?.ok) {
      console.error('[发送失败业务级异常]:', copyRes.data);
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
