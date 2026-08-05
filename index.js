// npm i telegraf axios dotenv

require("dotenv").config();

const axios = require("axios");
const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;

const bot = new Telegraf(BOT_TOKEN);

const MAX_HISTORY = 15;

const history = new Map();

let aiDisabled = false;

// Track pending requests per chat - using queue system
const requestQueues = new Map();
const processingChats = new Map();

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
            text: text
        });

    }

    return next();

});

// -------------------- Queue Processor --------------------

async function processQueue(chatId) {
    // If already processing this chat, return
    if (processingChats.get(chatId)) {
        return;
    }

    // Get the queue for this chat
    const queue = requestQueues.get(chatId);
    if (!queue || queue.length === 0) {
        return;
    }

    // Mark as processing
    processingChats.set(chatId, true);

    try {
        // Process all items in queue one by one
        while (queue.length > 0) {
            const requestItem = queue.shift();
            const { ctx, prompt } = requestItem;
            
            try {
                await generateAIResponse(ctx, prompt);
            } catch (err) {
                console.error("Error processing queued request:", err);
                // Continue with next request even if one fails
            }
        }
    } finally {
        // Clear processing flag
        processingChats.delete(chatId);
        
        // Check if new items were added while processing
        const remainingQueue = requestQueues.get(chatId);
        if (remainingQueue && remainingQueue.length > 0) {
            // Process new items
            processQueue(chatId);
        }
    }
}

// -------------------- AI Response Function --------------------

async function generateAIResponse(ctx, prompt) {
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    try {
        const context = [];

        context.push(
            `You are a helpful AI assistant and a member of this Telegram group. You participate in conversations naturally, like a normal group member would.

Your personality traits:
- Friendly, helpful, and engaging
- Responds naturally to conversations
- Has a good sense of humor when appropriate
- Respects other group members
- Contributes meaningfully to discussions
- Stays on topic and doesn't spam

You are inside a Telegram group chat.

If the user replies to one of YOUR previous messages, continue the same conversation naturally instead of starting over.

IMPORTANT: When referring to a specific noun or entity mentioned in the conversation, always acknowledge and address it properly. Do not ignore nouns that users explicitly reference.`
        );

        context.push("");
        context.push("Recent conversation:");

        const hist = getHistory(ctx.chat.id);

        for (const msg of hist) {

            context.push(
                `${msg.isBot ? "Assistant" : "User"}:
${msg.text}`
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
`User replied to:
${repliedText}`
                );

            }

        }

        context.push("");
        context.push(
`Current user request:
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
                "https://api.bk9.dev/ai/BK91",
                {
                    params: {
                        q: finalPrompt,
                        BK9: "you are a helpful AI assistant and a member of this Telegram group"
                    },
                    timeout: 60000,
                    headers: {
                        'Accept': 'application/json, text/plain, */*'
                    }
                }
            );

            clearInterval(typing);

            const rawReply =
                data?.BK9 ||
                data?.response ||
                "No response.";

            // Save bot response to history
            pushHistory(ctx.chat.id, {
                isBot: true,
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

            // Silently fail - no error message sent to user

        }

    } catch (err) {
        console.error("Error in generateAIResponse:", err);
    }
}

// -------------------- Queue Handler --------------------

function queueRequest(ctx, prompt) {
    const chatId = ctx.chat.id;
    
    // Initialize queue for this chat if it doesn't exist
    if (!requestQueues.has(chatId)) {
        requestQueues.set(chatId, []);
    }
    
    // Add request to queue
    const queue = requestQueues.get(chatId);
    queue.push({ ctx, prompt });
    
    // Start processing the queue
    processQueue(chatId);
}

// -------------------- Command --------------------

bot.command("yo", async (ctx) => {

    if (aiDisabled) {
        return; // Silently ignore
    }

    let prompt = ctx.message.text
        .replace(/^\/yo(@\w+)?/i, "")
        .trim();

    if (!prompt)
        prompt = "Reply naturally.";

    // Queue the request instead of processing immediately
    queueRequest(ctx, prompt);

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

        // Queue the request instead of processing immediately
        queueRequest(ctx, prompt);
    }
});

bot.launch();

console.log("Bot started.");
console.log("Using BK9 API - Telegram Group Member");
console.log("Requests will be processed sequentially per chat.");
