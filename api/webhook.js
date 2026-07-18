const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 统一排版
function buildUnifiedCaption(text) {
    return `✨ <b>转发内容</b>\n──────────\n${text || ''}`;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    const { channel_post } = req.body;
    if (!channel_post) return res.status(200).send('OK');

    // 调试：如果没收到消息，直接终止
    const chatId = process.env.TARGET_CHAT_ID;
    if (!chatId) {
        console.error("错误：未设置 TARGET_CHAT_ID");
        return res.status(200).send('OK');
    }

    // 智能提取媒体：无论是视频还是文档(有些视频是文档格式)
    const media = channel_post.video || channel_post.document || channel_post.photo?.pop() || null;
    const text = channel_post.caption || channel_post.text || '';

    try {
        if (media) {
            // 如果是视频或文档
            await fetch(`${TELEGRAM_API}/sendVideo`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    chat_id: chatId,
                    video: media.file_id,
                    caption: buildUnifiedCaption(text),
                    parse_mode: 'HTML'
                })
            });
        } else if (text) {
            // 如果只是纯文本
            await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    chat_id: chatId,
                    text: buildUnifiedCaption(text),
                    parse_mode: 'HTML'
                })
            });
        }
    } catch (e) {
        // 打印错误到控制台，这是排查的关键
        console.error('发送错误详情:', e.message);
    }

    return res.status(200).send('OK');
}
