import {
  AttachmentBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";
import { logger } from "./logger";
import { getOpenRouterReply, type OpenRouterChatMessage } from "./openrouter";
import { createVouchCard } from "./vouch-card";

const DEFAULT_VOUCH_CHANNEL_ID = "1563987725168681111";
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const AI_COOLDOWN_MS = 4_000;
const VOUCH_COOLDOWN_MS = 60_000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_DISCORD_MESSAGE_LENGTH = 1_900;
const DELTA_RESPONSE = "It's working and updated.";
const SYSTEM_PROMPT =
  "You are CocoX.wtf's friendly Discord helper. Answer the user's question clearly and conversationally. Do not claim you checked live systems, accounts, or external services. If asked about Delta, the bot handles that separately. Do not make up endorsements, user identities, or facts about CocoX.wtf.";

type Conversation = {
  messages: OpenRouterChatMessage[];
  lastActivityAt: number;
};

const conversations = new Map<string, Conversation>();
const lastAiReplyAt = new Map<string, number>();
const lastVouchAt = new Map<string, number>();

function conversationKey(message: Message): string {
  return `${message.guildId ?? "dm"}:${message.channelId}:${message.author.id}`;
}

function trimDiscordMessage(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_DISCORD_MESSAGE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_DISCORD_MESSAGE_LENGTH - 1).trimEnd()}…`;
}

function pruneExpiredState(now = Date.now()): void {
  for (const [key, conversation] of conversations) {
    if (now - conversation.lastActivityAt > SESSION_TTL_MS) {
      conversations.delete(key);
    }
  }

  for (const [key, timestamp] of lastAiReplyAt) {
    if (now - timestamp > AI_COOLDOWN_MS * 2) lastAiReplyAt.delete(key);
  }

  for (const [key, timestamp] of lastVouchAt) {
    if (now - timestamp > VOUCH_COOLDOWN_MS * 2) lastVouchAt.delete(key);
  }
}

async function replyWithoutMentions(message: Message, content: string): Promise<void> {
  await message.reply({
    content: trimDiscordMessage(content),
    allowedMentions: { parse: [], repliedUser: false },
  });
}

function isVouchCommand(content: string): boolean {
  return /^!vouch(?:\s|$)/i.test(content.trim());
}

async function handleVouchCommand(client: Client, message: Message): Promise<void> {
  const feedback = message.content.trim().replace(/^!vouch(?:\s+|$)/i, "").trim();
  if (!feedback) {
    await replyWithoutMentions(
      message,
      "To post your own feedback, use `!vouch` followed by what you want to say. It will be shown publicly in the CocoX.wtf vouch channel under your Discord username.",
    );
    return;
  }

  if (feedback.length > 320) {
    await replyWithoutMentions(
      message,
      "Please keep your own feedback to 320 characters or fewer.",
    );
    return;
  }

  if (!message.guildId) {
    await replyWithoutMentions(message, "Vouches can only be submitted in a server.");
    return;
  }

  const now = Date.now();
  const cooldownKey = `${message.guildId}:${message.author.id}`;
  const previousSubmission = lastVouchAt.get(cooldownKey);
  if (previousSubmission && now - previousSubmission < VOUCH_COOLDOWN_MS) {
    await replyWithoutMentions(message, "Please wait a minute before submitting another vouch.");
    return;
  }

  const targetChannelId =
    process.env.VOUCH_CHANNEL_ID?.trim() || DEFAULT_VOUCH_CHANNEL_ID;
  let targetChannel;

  try {
    targetChannel = await client.channels.fetch(targetChannelId);
  } catch {
    await replyWithoutMentions(
      message,
      "I couldn't access the configured vouch channel. Check its ID and make sure the bot can view and post there.",
    );
    return;
  }

  if (
    !targetChannel ||
    !targetChannel.isTextBased() ||
    !("send" in targetChannel) ||
    !("guildId" in targetChannel) ||
    targetChannel.guildId !== message.guildId
  ) {
    await replyWithoutMentions(
      message,
      "The configured vouch channel must be a text channel in this server.",
    );
    return;
  }

  try {
    const image = await createVouchCard({
      displayName:
        message.member?.displayName ??
        message.author.globalName ??
        message.author.username,
      username: message.author.username,
      feedback,
      submittedAt: new Date(now),
    });

    const attachment = new AttachmentBuilder(image, {
      name: "cocox-community-vouch.png",
    });
    const embed = new EmbedBuilder()
      .setColor(0x8b7cff)
      .setTitle("CocoX.wtf — Community Vouch")
      .setDescription(feedback)
      .addFields(
        {
          name: "Submitted by",
          value: `@${message.author.username}`,
          inline: true,
        },
        { name: "Disclosure", value: "User-submitted feedback", inline: true },
      )
      .setImage("attachment://cocox-community-vouch.png")
      .setTimestamp(new Date(now));

    await targetChannel.send({
      embeds: [embed],
      files: [attachment],
      allowedMentions: { parse: [] },
    });
    lastVouchAt.set(cooldownKey, now);

    await replyWithoutMentions(
      message,
      `Your feedback was posted to <#${targetChannelId}> under your Discord username.`,
    );
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : "Unknown error" },
      "Could not publish community vouch",
    );
    await replyWithoutMentions(
      message,
      "I couldn't post that feedback. Check that I can send messages and attach files in the vouch channel, then try again.",
    );
  }
}

async function handleConversationMessage(
  message: Message,
  key: string,
  conversation: Conversation,
): Promise<void> {
  const now = Date.now();
  const text = message.content.trim();
  conversation.lastActivityAt = now;

  if (/^!stop$/i.test(text)) {
    conversations.delete(key);
    await replyWithoutMentions(message, "Okay, I’ve ended this conversation.");
    return;
  }

  if (/\bdelta\b/i.test(text)) {
    conversation.messages.push(
      { role: "user", content: text },
      { role: "assistant", content: DELTA_RESPONSE },
    );
    conversation.messages = conversation.messages.slice(-MAX_HISTORY_MESSAGES);
    await replyWithoutMentions(message, DELTA_RESPONSE);
    return;
  }

  const previousAiReply = lastAiReplyAt.get(key);
  if (previousAiReply && now - previousAiReply < AI_COOLDOWN_MS) {
    await replyWithoutMentions(message, "Give me a few seconds, then send that again.");
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    await replyWithoutMentions(
      message,
      "The AI isn’t connected yet. The bot owner needs to add an OpenRouter API key to the project’s Secrets. Delta replies and vouch cards still work.",
    );
    return;
  }

  conversation.messages.push({ role: "user", content: text });
  conversation.messages = conversation.messages.slice(-MAX_HISTORY_MESSAGES);
  lastAiReplyAt.set(key, now);

  try {
    const answer = await getOpenRouterReply([
      { role: "system", content: SYSTEM_PROMPT },
      ...conversation.messages,
    ]);
    conversation.messages.push({ role: "assistant", content: answer });
    conversation.messages = conversation.messages.slice(-MAX_HISTORY_MESSAGES);
    conversation.lastActivityAt = Date.now();
    await replyWithoutMentions(message, answer);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : "Unknown error" },
      "OpenRouter chat request failed",
    );
    await replyWithoutMentions(
      message,
      "The free AI model is unavailable right now. Please try again in a little while.",
    );
  }
}

async function handleMessage(
  client: Client,
  message: Message,
  ownerDiscordId: string | undefined,
): Promise<void> {
  if (message.author.bot || !message.guildId) return;

  pruneExpiredState();

  if (isVouchCommand(message.content)) {
    await handleVouchCommand(client, message);
    return;
  }

  const key = conversationKey(message);
  if (ownerDiscordId && message.mentions.users.has(ownerDiscordId)) {
    conversations.set(key, { messages: [], lastActivityAt: Date.now() });
    await replyWithoutMentions(message, "What do you need? Send your question here and I’ll help.");
    return;
  }

  const conversation = conversations.get(key);
  if (!conversation || !message.content.trim()) return;
  await handleConversationMessage(message, key, conversation);
}

export async function startDiscordBot(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  if (!token) {
    logger.warn(
      "Discord bot is not connected. Add DISCORD_BOT_TOKEN to project Secrets to enable it.",
    );
    return;
  }

  const configuredOwnerId = process.env.OWNER_DISCORD_ID?.trim();
  const ownerDiscordId =
    configuredOwnerId && /^\d{17,20}$/.test(configuredOwnerId)
      ? configuredOwnerId
      : undefined;

  if (!ownerDiscordId) {
    logger.warn(
      "OWNER_DISCORD_ID is missing or invalid; mention-triggered AI chats are disabled.",
    );
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      { username: readyClient.user.username },
      "Discord bot is connected",
    );
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(client, message, ownerDiscordId).catch((error: unknown) => {
      logger.warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          channelId: message.channelId,
        },
        "Discord message handler failed",
      );
    });
  });

  client.on(Events.Error, () => {
    logger.error("Discord client connection error.");
  });

  try {
    await client.login(token);
  } catch {
    logger.error(
      "Discord login failed. Check DISCORD_BOT_TOKEN and the bot's server permissions.",
    );
    client.destroy();
  }

  const cleanupTimer = setInterval(pruneExpiredState, SESSION_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}
