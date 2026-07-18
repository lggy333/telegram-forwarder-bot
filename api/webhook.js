export default async function handler(req, res) {
  // 第一时间返回 200，防止 Telegram Webhook 重试
  res.status(200).send("OK");

  try {
    if (req.method !== "POST") return;

    // 每个 Vercel 实例只生成一次 ID
    if (!global.instanceId) {
      global.instanceId = Math.random().toString(36).slice(2, 8);
    }

    const { channel_post } = req.body || {};

    console.log("====================================");
    console.log("INSTANCE:", global.instanceId);
    console.log("PID:", process.pid);
    console.log("TIME:", new Date().toISOString());

    if (!channel_post) {
      console.log("No channel_post");
      return;
    }

    console.log("message_id:", channel_post.message_id);
    console.log("media_group_id:", channel_post.media_group_id || "NONE");

    const BOT_TOKEN = process.env.BOT_TOKEN;
    const CHANNEL_ID = process.env.CHANNEL_ID;
    const chatId = channel_post.chat.id;

    // 只处理目标频道
    if (String(chatId) !== String(CHANNEL_ID)) {
      console.log("Skip: other chat");
      return;
    }

    // 忽略机器人自己发送的消息
    if (
      channel_post.author_signature === "Bot" ||
      (channel_post.from && channel_post.from.is_bot)
    ) {
      console.log("Skip: bot message");
      return;
    }

    const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const messageId = channel_post.message_id;

    console.log("Start copyMessage:", messageId);

    const copyResponse = await fetch(`${TELEGRAM_API}/copyMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        from_chat_id: CHANNEL_ID,
        message_id: messageId,
      }),
    });

    const copyResult = await copyResponse.json();

    console.log("copyMessage result:", copyResult.ok);

    if (copyResult.ok) {
      console.log("Deleting:", messageId);

      const deleteResponse = await fetch(`${TELEGRAM_API}/deleteMessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          message_id: messageId,
        }),
      });

      const deleteResult = await deleteResponse.json();

      console.log("deleteMessage result:", deleteResult.ok);
    }

    console.log("Done:", messageId);
  } catch (err) {
    console.error("Webhook Error:", err);
  }
}
