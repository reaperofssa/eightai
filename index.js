// npm i telegraf
require('dotenv').config();
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const bot = new Telegraf(BOT_TOKEN);

// ===== CONFIG =====
const MODEL = "gemini-2.5-flash";
const MAX_HISTORY = 5;

// chat history
const history = new Map();

// ignore AI after quota/rate limit
let aiDisabled = false;

bot.on("message", (ctx, next) => {
    const chatId = ctx.chat.id;

    if (!history.has(chatId)) history.set(chatId, []);

    const arr = history.get(chatId);

    if (ctx.message.text) {
        arr.push({
            from: ctx.from.first_name,
            text: ctx.message.text,
        });

        while (arr.length > MAX_HISTORY)
            arr.shift();
    }

    return next();
});

bot.command("yo", async (ctx) => {

    if (aiDisabled) return;

    let prompt = ctx.message.text.replace(/^\/yo(@\w+)?/i, "").trim();

    const context = [];

    // Previous messages
    const hist = history.get(ctx.chat.id) || [];

    if (hist.length) {
        context.push("Recent chat:");
        hist.forEach(m => {
            context.push(`${m.from}: ${m.text}`);
        });
    }

    // Replied message
    if (ctx.message.reply_to_message) {

        const r = ctx.message.reply_to_message;

        let replied = "";

        if (r.text)
            replied = r.text;
        else if (r.caption)
            replied = r.caption;
        else
            replied = "[non-text message]";

        context.push("");
        context.push("Quoted message:");
        context.push(`${r.from.first_name}: ${replied}`);
    }

    if (!prompt)
        prompt = "Reply naturally to the conversation.";

    const finalPrompt = `
You are chatting inside a Telegram group.

${context.join("\n")}

User request:
${prompt}
`;

    try {

        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": GEMINI_API_KEY
                },
                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                {
                                    text: finalPrompt
                                }
                            ]
                        }
                    ]
                })
            }
        );

        // Disable AI forever if free quota is exhausted
        if (res.status === 429) {
            console.log("Gemini quota reached. AI disabled.");
            aiDisabled = true;
            return;
        }

        const data = await res.json();

        const text =
            data.candidates?.[0]?.content?.parts
                ?.map(x => x.text)
                .join("")
            || "No response.";

        await ctx.reply(text, {
            reply_parameters: {
                message_id: ctx.message.message_id
            }
        });

    } catch (err) {
        console.error(err);
    }

});

bot.launch();

console.log("Bot started");
