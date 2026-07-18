const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 统一排版生成函数
function buildUnifiedCaption(text) {
    return `✨ <b>转发内容</b>\n──────────\n${text || ''}`;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    const body = req.body || {};
    // 【核心修复】兼容所有触发源
    const msg = body.channel_post || body.message;

    // 检查是否有消息内容
    if (!msg) {
        console.log("未发现有效消息对象");
        return res.status(200).send('OK');
    }

    const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
    if (!TARGET_CHAT_ID) {
        console.error("错误：TARGET_CHAT_ID 未配置");
        return res.status(200).send('OK');
    }

    const text = msg.caption || msg.text || '';
    
    // 判断媒体类型
    let method = 'sendMessage';
    let payload = { chat_id: TARGET_CHAT_ID, text: buildUnifiedCaption(text), parse_mode: 'HTML' };

    if (msg.video) {
        method = 'sendVideo';
        payload = { chat_id: TARGET_CHAT_ID, video: msg.video.file_id, caption: buildUnifiedCaption(text), parse_mode: 'HTML' };
    } else if (msg.photo) {
        method = 'sendPhoto';
        // photo 是数组，取最后一个（通常是最大分辨率）
        payload = { chat_id: TARGET_CHAT_ID, photo: msg.photo[msg.photo.length - 1].file_id, caption: buildUnifiedCaption(text), parse_mode: 'HTML' };
    }

    console.log(`执行方法: ${method}, 目标: ${TARGET_CHAT_ID}`);

    try {
        const response = await fetch(`${TELEGRAM_API}/${method}`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(payload)
        });

        const result = await response.json();
        console.log("Telegram API 响应:", JSON.stringify(result));
    } catch (e) {
        console.error('API 发送失败:', e.message);
    }

    return res.status(200).send('OK');
}
