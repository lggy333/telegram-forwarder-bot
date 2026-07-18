import { Bot, webhookCallback } from "grammy";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const ADMIN_ID = Number(process.env.ADMIN_ID);

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required!");

const bot = new Bot(BOT_TOKEN);

// 核心拦截：只处理你本人发给 Bot 的消息
bot.on("message", async (ctx) => {
  if (ctx.from && ctx.from.id === ADMIN_ID) {
    const chatId = ctx.chat.id;
    const messageId = ctx.message.message_id;

    try {
      // 1. 无痕重发到你的私有频道（不带转发小尾巴）
      await ctx.api.copyMessage(CHANNEL_ID, chatId, messageId);

      // 2. 成功后瞬间抹除你和 Bot 对话框里的原消息
      await ctx.api.deleteMessage(chatId, messageId);
    } catch (error) {
      console.error("无痕归档失败，错误详情:", error);
    }
  }
});

// 适配 Vercel 的 Webhook 导出
export default webhookCallback(bot, "next-connect");
