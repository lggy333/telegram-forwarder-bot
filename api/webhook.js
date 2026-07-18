/**
 * 转发机器人完整代码
 * 功能：自动转发频道内容，并将排版统一为：文字在前，视频在后（发送时）
 */

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 统一排版生成函数
function buildUnifiedCaption(text) {
    const lines = [];
    lines.push(`✨ <b>转发内容</b>`);
    lines.push('──────────');
    lines.push(text || ''); // 这里可以加入你的自定义排版逻辑
    return lines.join('\n');
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).send('OK');

    const { channel_post } = req.body;
    if (!channel_post) return res.status(200).send('OK');

    // 目标频道 ID
    const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
    
    // 提取媒体信息
    const video = channel_post.video || channel_post.document || null;
    const text = channel_post.caption || channel_post.text || '';

    // 如果是视频，使用 sendVideo 强制重排
    if (video) {
        try {
            await fetch(`${TELEGRAM_API}/sendVideo`, {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    chat_id: TARGET_CHAT_ID,
                    video: video.file_id,
                    caption: buildUnifiedCaption(text),
                    parse_mode: 'HTML'
                })
            });
        } catch (e) {
            console.error('发送视频失败:', e);
        }
    } 
    // 如果是纯文本，直接发送
    else if (text) {
        await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                chat_id: TARGET_CHAT_ID,
                text: buildUnifiedCaption(text),
                parse_mode: 'HTML'
            })
        });
    }

    return res.status(200).send('OK');
}
