// npm i telegraf axios bdotenv

require("dotenv").config();

const axios = require("axios");
const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = "agentknbot"; // your bot's @username, no @ — needed for verify deep link

const bot = new Telegraf(BOT_TOKEN);

const MAX_HISTORY = 15;

const history = new Map();

let aiDisabled = false;

// Track pending requests per chat - using queue system
const requestQueues = new Map();
const processingChats = new Map();

// ==================== VERIFICATION CONFIG ====================

const verification = true; // <-- master toggle for join-verification system

const REQUIRED_CHANNEL = "@eightballs"; // channel bot must be admin in, to check membership
const CHANNEL_JOIN_URL = "https://t.me/eightballs";

// pendingVerification: Map<chatId, Map<userId, { messageId }>>
const pendingVerification = new Map();

function getPending(chatId) {
    if (!pendingVerification.has(chatId)) pendingVerification.set(chatId, new Map());
    return pendingVerification.get(chatId);
}

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

// ==================== VERIFICATION: MUTE / UNMUTE HELPERS ====================

async function muteUser(ctx, chatId, userId) {
    await ctx.telegram.restrictChatMember(chatId, userId, {
        permissions: {
            can_send_messages: false,
            can_send_audios: false,
            can_send_documents: false,
            can_send_photos: false,
            can_send_videos: false,
            can_send_video_notes: false,
            can_send_voice_notes: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false,
            can_manage_topics: false
        }
    });
}

async function unmuteUser(ctx, chatId, userId) {
    // Standard member permission set — adjust if your group restricts
    // media/polls for everyone by default.
    await ctx.telegram.restrictChatMember(chatId, userId, {
        permissions: {
            can_send_messages: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
            can_send_videos: true,
            can_send_video_notes: true,
            can_send_voice_notes: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
            can_change_info: false,
            can_invite_users: true,
            can_pin_messages: false,
            can_manage_topics: false
        }
    });
}

// ==================== VERIFICATION: HANDLERS ====================

if (verification) {

    if (!BOT_USERNAME) {
        console.warn("[verification] BOT_USERNAME env var not set — deep link button will not work.");
    }

    // ---- New member joins -> mute + prompt ----
    bot.on("new_chat_members", async (ctx) => {
        const chatId = ctx.chat.id;

        for (const member of ctx.message.new_chat_members) {
            if (member.is_bot) continue; // don't gate other bots

            const userId = member.id;

            try {
                await muteUser(ctx, chatId, userId);
            } catch (err) {
                console.error("[verification] Failed to mute new member:", err.message);
                continue; // if we can't mute (missing admin rights), don't send a false prompt
            }

            const deepLink = `https://t.me/${BOT_USERNAME}?start=verify_${userId}`;

            const sent = await ctx.reply(
                `👋 Welcome, <a href="tg://user?id=${userId}">${escapeHtml(member.first_name || "there")}</a> — verify you're human to gain access to the chat.`,
                {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Verify", url: deepLink }]
                        ]
                    }
                }
            );

            getPending(chatId).set(userId, { messageId: sent.message_id });
        }
    });

    // ---- User DMs the bot via the deep link: /start verify_<userId> ----
    bot.start(async (ctx) => {
        const payload = ctx.startPayload; // telegraf parses ?start=XXXX into this

        if (!payload || !payload.startsWith("verify_")) {
            return ctx.reply("👋 Hi! Nothing to verify right now.");
        }

        const targetUserId = payload.replace("verify_", "");
        const clickerId = String(ctx.from.id);

        if (targetUserId !== clickerId) {
            return ctx.reply("❌ This isn't your verification.");
        }

        // Confirmed it's the right person -> ask them to join the channel
        await ctx.reply(
            `To gain access to the chat, please join our channel below, then tap Verify.`,
            Markup.inlineKeyboard([
                [Markup.button.url("Join Channel", CHANNEL_JOIN_URL)],
                [Markup.button.callback("Verify", `check_verify_${targetUserId}`)]
            ])
        );
    });

    // ---- User taps "Verify" -> check channel membership ----
    bot.action(/^check_verify_(\d+)$/, async (ctx) => {
        const targetUserId = ctx.match[1];
        const clickerId = String(ctx.from.id);

        if (targetUserId !== clickerId) {
            return ctx.answerCbQuery("This isn't your verification.", { show_alert: true });
        }

        let member;
        try {
            member = await ctx.telegram.getChatMember(REQUIRED_CHANNEL, targetUserId);
        } catch (err) {
            console.error("[verification] getChatMember failed:", err.message);
            return ctx.answerCbQuery("Couldn't check membership right now, try again.", { show_alert: true });
        }

        const validStatuses = ["member", "administrator", "creator"];

        if (!validStatuses.includes(member.status)) {
            return ctx.answerCbQuery("You haven't joined the chat.", { show_alert: true });
        }

        // Joined -> unmute them in every group where they're pending
        let unmutedAnywhere = false;

        for (const [chatId, pending] of pendingVerification.entries()) {
            const entry = pending.get(Number(targetUserId)) || pending.get(targetUserId);
            if (entry) {
                try {
                    await unmuteUser(ctx, chatId, targetUserId);
                    unmutedAnywhere = true;
                    pending.delete(Number(targetUserId));
                    pending.delete(targetUserId);

                    if (entry.messageId) {
                        try {
                            await ctx.telegram.editMessageText(
                                chatId,
                                entry.messageId,
                                undefined,
                                "Verified",
                                { reply_markup: { inline_keyboard: [] } }
                            );
                        } catch (err) {
                            console.error("[verification] Failed to edit group message:", err.message);
                        }
                    }
                } catch (err) {
                    console.error("[verification] Failed to unmute:", err.message);
                }
            }
        }

        await ctx.answerCbQuery("Verified! You've been unmuted.", { show_alert: true });
        await ctx.editMessageText("✅ Verification complete — you now have access to the chat.");

        if (!unmutedAnywhere) {
            console.warn(`[verification] User ${targetUserId} verified but was not found in any pending list.`);
        }
    });
}

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

IMPORTANT: When referring to a specific noun or entity mentioned in the conversation, always acknowledge and address it properly. Do not ignore nouns that users explicitly reference.

IMPORTANT: The "Recent conversation" section below is background context only, from other group members and possibly unrelated to the current request. Do NOT bring it up, reference it, or comment on it unless the current user request is clearly a continuation of it or explicitly asks about it. Focus your reply on the current user request.`
        );

        context.push("");
        context.push("Recent conversation (background only, may be unrelated):");

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
`Current user request (respond to THIS, not the background conversation, unless it is clearly connected):
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

// -------------------- /whisper Command --------------------
// Usage: reply to a user's message with: /whisper <query>
// Sends an ephemeral message (only the target user + bot can see it) via the
// Bot API's receiver_user_id parameter. Requires the bot to be a chat admin.

bot.command("whisper", async (ctx) => {
    const repliedTo = ctx.message.reply_to_message;

    let rawArgs = ctx.message.text
        .replace(/^\/whisper(@\w+)?/i, "")
        .trim();

    let targetUser = repliedTo ? repliedTo.from : null;

    // Fallback: /whisper <query> <userid> (no reply) — trailing numeric arg is the target id
    if (!targetUser) {
        const parts = rawArgs.split(/\s+/);
        const lastPart = parts[parts.length - 1];

        if (/^\d+$/.test(lastPart)) {
            const userId = Number(lastPart);
            rawArgs = parts.slice(0, -1).join(" ").trim();

            try {
                const member = await ctx.telegram.getChatMember(ctx.chat.id, userId);
                targetUser = member.user;
            } catch (err) {
                return ctx.reply("Couldn't find that user in this chat.");
            }
        }
    }

    if (!targetUser) {
        return ctx.reply("Reply to a user's message with /whisper <query>, or use /whisper <query> <userid>.");
    }

    if (targetUser.is_bot) {
        return ctx.reply("Can't whisper to a bot.");
    }

    const query = rawArgs;

    if (!query) {
        return ctx.reply("Usage: reply to a user, then /whisper <query> (or /whisper <query> <userid>)");
    }

    // Build a clickable name tag using a text_mention entity (works even if
    // the user has no @username, since it links via tg://user?id=).
    const mentionName = targetUser.first_name || "there";
    const prefix = `${mentionName} `; // text before the query, mention covers this span

    const text = `${prefix}${query}`;

    try {
        await ctx.telegram.callApi("sendMessage", {
            chat_id: ctx.chat.id,
            receiver_user_id: targetUser.id, // only this user + bot see it
            text,
            entities: [
                {
                    type: "text_mention",
                    offset: 0,
                    length: mentionName.length,
                    user: { id: targetUser.id }
                }
            ]
        });
    } catch (err) {
        console.error("[whisper] Failed to send ephemeral message:", err.response?.description || err.message);
        // Fall back: if ephemeral messages aren't supported/enabled, let the
        // sender know rather than silently failing.
        await ctx.reply("Couldn't send a private whisper (ephemeral messages may not be available here).");
    }
});

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
console.log(`Verification system: ${verification ? "ENABLED" : "disabled"}`);
