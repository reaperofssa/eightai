// npm i telegraf axios dotenv

require("dotenv").config();

const axios = require("axios");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;

const bot = new Telegraf(BOT_TOKEN);

const MAX_HISTORY = 15;

const history = new Map();

let aiDisabled = false;

// Track pending requests per chat
const pendingRequests = new Map();

// -------------------- Formatting --------------------

function escapeHtml(text = "") {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function markdownToHtml(text = "") {
    text = escapeHtml(text);

    text = text.replace(/```([\s\S]*?)```/g, "<pre>$1</pre>");
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    text = text.replace(/\*\*(.*?)\*\*/gs, "<b>$1</b>");
    text = text.replace(/\*(.*?)\*/gs, "<i>$1</i>");

    return text;
}

// -------------------- History --------------------

function getHistory(chatId) {
    if (!history.has(chatId))
        history.set(chatId, []);

    return history.get(chatId);
}

function pushHistory(chatId, entry) {

    const arr = getHistory(chatId);

    arr.push(entry);

    while (arr.length > MAX_HISTORY)
        arr.shift();

}

// Save every incoming message
bot.on("message", (ctx, next) => {

    const text =
        ctx.message.text ||
        ctx.message.caption;

    if (text) {

        pushHistory(ctx.chat.id, {
            isBot: false,
            id: ctx.from.id,
            username: ctx.from.username || "",
            name: ctx.from.first_name || "Unknown",
            text
        });

    }

    return next();

});

// -------------------- AI Response Function --------------------

async function generateAIResponse(ctx, prompt) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    // Handle simultaneous requests
    if (!pendingRequests.has(chatId)) {
        pendingRequests.set(chatId, new Map());
    }

    const chatPending = pendingRequests.get(chatId);

    if (chatPending.has(userId)) {
        await ctx.reply("⏳ Your previous request is still processing. Please wait.");
        return;
    }

    chatPending.set(userId, true);

    try {
        const context = [];

        context.push(
            `You are an AI assistant inside a Telegram group.

Each message includes:
- Name
- Telegram User ID

Use the IDs to distinguish different people.

If the user replies to one of YOUR previous messages, continue the same conversation naturally instead of starting over.

Never confuse users that have different IDs.

IMPORTANT: When referring to a specific noun or entity mentioned in the conversation, always acknowledge and address it properly. Do not ignore nouns that users explicitly reference.`
        );

        context.push("");
        context.push("Recent conversation:");

        const hist = getHistory(ctx.chat.id);

        for (const msg of hist) {

            context.push(
                `${msg.isBot ? "Assistant" : "User"}
Name: ${msg.name}
ID: ${msg.id}
${msg.username ? `Username: @${msg.username}` : ""}
Message:
${msg.text}
`
            );

        }

        // Reply context
        if (ctx.message.reply_to_message) {

            const r = ctx.message.reply_to_message;

            const repliedText =
                r.text ||
                r.caption ||
                "[Non-text message]";

            context.push("");

            if (r.from.id === bot.botInfo.id) {

                context.push("IMPORTANT:");
                context.push("The user is replying to YOUR previous message.");
                context.push("Continue that conversation.");
                context.push("");

                context.push("Your previous reply:");
                context.push(repliedText);

            } else {

                context.push("IMPORTANT:");
                context.push("The user is replying to another participant.");
                context.push("");

                context.push(
                    `Name: ${r.from.first_name || "Unknown"}
ID: ${r.from.id}
${r.from.username ? `Username: @${r.from.username}` : ""}

Message:
${repliedText}`
                );

            }

        }

        context.push("");
        context.push(
            `Current user

Name: ${ctx.from.first_name}
ID: ${ctx.from.id}
${ctx.from.username ? `Username: @${ctx.from.username}` : ""}

Request:
${prompt}`
        );

        const finalPrompt = context.join("\n");

        await ctx.sendChatAction("typing");

        const typing = setInterval(() => {

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

            clearInterval(typing);

            const rawReply =
                data?.data ||
                "No response.";

            // Save bot response to history
            pushHistory(ctx.chat.id, {
                isBot: true,
                id: bot.botInfo.id,
                username: bot.botInfo.username,
                name: bot.botInfo.first_name,
                text: rawReply
            });

            await ctx.reply(
                markdownToHtml(rawReply),
                {
                    parse_mode: "HTML",
                    reply_parameters: {
                        message_id: ctx.message.message_id
                    }
                }
            );

        } catch (err) {

            clearInterval(typing);

            console.error(err.response?.data || err.message);

            if (
                err.response?.status === 429 ||
                err.response?.status === 403 ||
                err.response?.status === 402
            ) {
                aiDisabled = true;
            }

        }

    } finally {
        const chatPending = pendingRequests.get(chatId);
        if (chatPending) {
            chatPending.delete(userId);
            if (chatPending.size === 0) {
                pendingRequests.delete(chatId);
            }
        }
    }
}

// -------------------- Command --------------------

bot.command("yo", async (ctx) => {

    if (aiDisabled)
        return;

    let prompt = ctx.message.text
        .replace(/^\/yo(@\w+)?/i, "")
        .trim();

    if (!prompt)
        prompt = "Reply naturally.";

    await generateAIResponse(ctx, prompt);

});

// -------------------- Handle Replies to Bot --------------------

bot.on("message", async (ctx) => {
    // Check if this is a reply to the bot
    if (ctx.message.reply_to_message && 
        ctx.message.reply_to_message.from &&
        ctx.message.reply_to_message.from.id === bot.botInfo.id) {
        
        // Only respond if it's a text message
        if (!ctx.message.text) return;

        // Don't respond if AI is disabled
        if (aiDisabled) return;

        // Don't respond if it's a command
        if (ctx.message.text.startsWith('/')) return;

        // Get the user's message as the prompt
        let prompt = ctx.message.text.trim();
        
        if (!prompt) return;

        // Add context that this is a reply
        prompt = "This is a reply to your previous message. " + prompt;

        await generateAIResponse(ctx, prompt);
    }
});

bot.launch();

console.log("Bot started.");
