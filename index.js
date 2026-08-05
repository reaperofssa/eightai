// npm i telegraf axios dotenv

require("dotenv").config();

const axios = require("axios");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;

const bot = new Telegraf(BOT_TOKEN);

// ===== CONFIG =====
const MAX_HISTORY = 5;

// Store last messages per chat
const history = new Map();

// Disable AI if API starts rate limiting
let aiDisabled = false;

// Save recent messages
bot.on("message", (ctx, next) => {
    const chatId = ctx.chat.id;

    if (!history.has(chatId))
        history.set(chatId, []);

    const messages = history.get(chatId);

    let text = "";

    if (ctx.message.text)
        text = ctx.message.text;
    else if (ctx.message.caption)
        text = ctx.message.caption;

    if (text) {
        messages.push({
            from: ctx.from.first_name || ctx.from.username || "Unknown",
            text
        });

        while (messages.length > MAX_HISTORY)
            messages.shift();
    }

    return next();
});

bot.command("yo", async (ctx) => {

    if (aiDisabled)
        return;

    let prompt = ctx.message.text
        .replace(/^\/yo(@\w+)?/i, "")
        .trim();

    const context = [];

    // Recent chat history
    const hist = history.get(ctx.chat.id) || [];

    if (hist.length) {
        context.push("Recent messages:");

        for (const msg of hist) {
            context.push(`${msg.from}: ${msg.text}`);
        }
    }

    // Reply context
    if (ctx.message.reply_to_message) {

        const reply = ctx.message.reply_to_message;

        const repliedText =
            reply.text ||
            reply.caption ||
            "[Non-text message]";

        context.push("");
        context.push("Quoted message:");
        context.push(`${reply.from.first_name || "Unknown"}: ${repliedText}`);
    }

    if (!prompt)
        prompt = "Reply naturally to the conversation.";

    const finalPrompt = `
You are an AI assistant inside a Telegram group.

Use the previous conversation if it is relevant.

${context.join("\n")}

User:
${prompt}
`;

    // Show typing immediately
    await ctx.sendChatAction("typing");

    // Keep refreshing typing every 4 seconds
    const typingInterval = setInterval(() => {
        ctx.telegram
            .sendChatAction(ctx.chat.id, "typing")
            .catch(() => {});
    }, 4000);

    try {

        const { data } = await axios.get(
            "https://apis.davidcyril.name.ng/ai/grok-4.1-fast",
            {
                params: {
                    prompt: finalPrompt
                },
                timeout: 60000
            }
        );

        clearInterval(typingInterval);

        const reply = data?.data || "No response.";

        await ctx.reply(reply, {
            reply_parameters: {
                message_id: ctx.message.message_id
            }
        });

    } catch (err) {

        clearInterval(typingInterval);

        console.error(err.response?.data || err.message);

        // Disable AI if API quota/rate limit is reached
        if (
            err.response?.status === 429 ||
            err.response?.status === 403 ||
            err.response?.status === 402
        ) {
            console.log("AI disabled.");
            aiDisabled = true;
        }

    }

});

bot.launch();

console.log("Bot started.");
