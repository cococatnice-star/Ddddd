import {
  AttachmentBuilder,
  Client,
  ChannelType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ApplicationCommandOptionType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Guild,
  type ChatInputCommandInteraction,
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

const SERVER_SETUP_COMMAND = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Set up CocoX.wtf server channels")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("server")
      .setDescription("Create the channels shown in the CocoX.wtf server layout"),
  )
  .toJSON();

const CREATE_ROLES_COMMAND = new SlashCommandBuilder()
  .setName("create")
  .setDescription("Create CocoX.wtf server roles")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("roles")
      .setDescription("Create community roles and moderator permissions"),
  )
  .toJSON();

const MODERATOR_ROLE_PERMISSIONS =
  PermissionFlagsBits.ModerateMembers |
  PermissionFlagsBits.MuteMembers |
  PermissionFlagsBits.DeafenMembers |
  PermissionFlagsBits.ManageMessages |
  PermissionFlagsBits.KickMembers;

type RolePreset = {
  name: string;
  color: number;
  permissions?: bigint;
};

const SERVER_ROLE_PRESETS: readonly RolePreset[] = [
  { name: "New Member", color: 0x95a5a6 },
  { name: "Member", color: 0x7289da },
  { name: "Verified", color: 0x43b581 },
  { name: "Trader", color: 0xe67e22 },
  { name: "Buyer", color: 0x2ecc71 },
  { name: "Seller", color: 0xe74c3c },
  { name: "Trusted Trader", color: 0x1abc9c },
  { name: "VIP", color: 0xf1c40f },
  { name: "Booster", color: 0xf47fff },
  { name: "Giveaway Winner", color: 0xff9966 },
  { name: "Creator", color: 0x3498db },
  { name: "Media", color: 0x9b59b6 },
  { name: "Support", color: 0x5865f2 },
  { name: "Helper", color: 0x57f287 },
  {
    name: "Moderator",
    color: 0xed4245,
    permissions: MODERATOR_ROLE_PERMISSIONS,
  },
  { name: "Bot", color: 0x99aab5 },
];

const SERVER_SETUP_CHANNELS = [
  {
    name: "Text Channels",
    type: ChannelType.GuildCategory,
    channels: [
      "💬general-chat",
      "🎁giveaway",
      "🔢counting",
      "✅vouches",
      "😎facereaveal",
      "📣announcements",
      "😔hall-of-shame",
      "traitfarms🔥",
    ],
  },
  {
    name: "Voice Channels",
    type: ChannelType.GuildCategory,
    channels: ["General", "Method vc", "goon vc", "Trade vc", "Admin abuse"],
  },
  {
    name: "Indexing",
    type: ChannelType.GuildCategory,
    channels: ["💿brainrots-index", "💎og-index’s"],
  },
  {
    name: "Trading",
    type: ChannelType.GuildCategory,
    channels: ["🤍small-trades", "💙mid-trades", "🧡og-trades", "🩵big-trades"],
  },
  {
    name: "Pub method",
    type: ChannelType.GuildCategory,
    channels: ["🔥pubmethod-steals", "😡pubmethod-sellouts"],
  },
  {
    name: "Key bypass🔑",
    type: ChannelType.GuildCategory,
    channels: ["🔑bypass"],
  },
] as const;

const SERVER_SETUP_ROOT_CHANNELS = ["📃rules"] as const;

type Conversation = {
  messages: OpenRouterChatMessage[];
  lastActivityAt: number;
};

const conversations = new Map<string, Conversation>();
const lastAiReplyAt = new Map<string, number>();
const lastVouchAt = new Map<string, number>();
const guildCommandRegistrations = new Map<string, Promise<void>>();

async function registerGuildCommands(guild: Guild): Promise<void> {
  const existingRegistration = guildCommandRegistrations.get(guild.id);
  if (existingRegistration) return existingRegistration;

  const registration = syncGuildCommands(guild).finally(() => {
    guildCommandRegistrations.delete(guild.id);
  });
  guildCommandRegistrations.set(guild.id, registration);
  return registration;
}

async function syncGuildCommands(guild: Guild): Promise<void> {
  const commands = await guild.commands.fetch();
  const existingSetupCommand = commands.find(
    (command) => command.name === SERVER_SETUP_COMMAND.name,
  );

  if (existingSetupCommand) {
    await existingSetupCommand.edit({
      name: "setup",
      description: "Set up CocoX.wtf server channels",
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "server",
          description: "Create the channels shown in the CocoX.wtf server layout",
        },
      ],
    });
  } else {
    await guild.commands.create(SERVER_SETUP_COMMAND);
  }

  const existingCreateCommand = commands.find(
    (command) => command.name === CREATE_ROLES_COMMAND.name,
  );

  if (existingCreateCommand) {
    await existingCreateCommand.edit({
      name: "create",
      description: "Create CocoX.wtf server roles",
      defaultMemberPermissions: PermissionFlagsBits.Administrator,
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "roles",
          description: "Create community roles and moderator permissions",
        },
      ],
    });
  } else {
    await guild.commands.create(CREATE_ROLES_COMMAND);
  }
}

async function handleCreateRoles(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Only server administrators can run `/create roles`.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.appPermissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: "I need the Manage Roles permission to create and configure roles.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: "Creating CocoX.wtf roles…",
    ephemeral: true,
  });

  const guild = interaction.guild;
  const created: string[] = [];
  const alreadyPresent: string[] = [];
  const failed: string[] = [];

  try {
    await guild.roles.fetch();

    for (const preset of SERVER_ROLE_PRESETS) {
      const existingRole = guild.roles.cache.find(
        (role) =>
          role.name.trim().toLocaleLowerCase() ===
          preset.name.trim().toLocaleLowerCase(),
      );

      try {
        if (existingRole) {
          alreadyPresent.push(`${preset.name} (matched ${existingRole.name})`);
          continue;
        }

        await guild.roles.create({
          name: preset.name,
          color: preset.color,
          permissions: preset.permissions ?? 0n,
          mentionable: false,
          reason: "CocoX.wtf /create roles",
        });
        created.push(preset.name);
      } catch {
        failed.push(preset.name);
      }
    }

    const summary = [
      `Role setup finished. Created ${created.length} role${created.length === 1 ? "" : "s"}.`,
      alreadyPresent.length
        ? `Skipped because they already exist; left unchanged: ${alreadyPresent.join(", ")}.`
        : "",
      failed.length
        ? `Could not create: ${failed.join(", ")}. Check the bot's role hierarchy and Manage Roles permission.`
        : "",
      "Roles are not assigned to members automatically. A newly created Moderator gets timeout, voice mute/deafen, message management, and kick permissions; existing roles are never changed.",
    ]
      .filter(Boolean)
      .join("\n");

    await interaction.editReply(summary);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : "Unknown error" },
      "Discord role setup failed",
    );
    await interaction.editReply(
      `Role setup stopped. Created ${created.length} role${created.length === 1 ? "" : "s"} before the error. Check the bot's Manage Roles permission and try again.`,
    );
  }
}

async function ensureSetupChannel(
  guild: Guild,
  name: string,
  type:
    | ChannelType.GuildText
    | ChannelType.GuildVoice
    | ChannelType.GuildCategory,
  parentId?: string,
): Promise<"created" | "exists" | "elsewhere"> {
  const matchingChannels = guild.channels.cache.filter(
    (channel) => channel.name === name,
  );
  const inExpectedLocation = matchingChannels.find(
    (channel) =>
      channel.type === type &&
      (parentId ? channel.parentId === parentId : channel.parentId === null),
  );

  if (inExpectedLocation) return "exists";
  if (matchingChannels.size > 0) return "elsewhere";

  await guild.channels.create({
    name,
    type,
    ...(parentId ? { parent: parentId } : {}),
  });
  return "created";
}

async function handleServerSetup(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Only server administrators can run `/setup server`.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.appPermissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "I need the Manage Channels permission to set up the server.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: "Setting up server…",
    ephemeral: true,
  });

  const created: string[] = [];
  const alreadyPresent: string[] = [];
  const foundElsewhere: string[] = [];
  const failed: string[] = [];
  const guild = interaction.guild;

  try {
    await guild.channels.fetch();

    for (const channelName of SERVER_SETUP_ROOT_CHANNELS) {
      try {
        const result = await ensureSetupChannel(
          guild,
          channelName,
          ChannelType.GuildText,
        );
        if (result === "created") created.push(channelName);
        else if (result === "exists") alreadyPresent.push(channelName);
        else foundElsewhere.push(channelName);
      } catch {
        failed.push(channelName);
      }
    }

    for (const category of SERVER_SETUP_CHANNELS) {
      let categoryId: string | undefined;

      try {
        const categoryResult = await ensureSetupChannel(
          guild,
          category.name,
          ChannelType.GuildCategory,
        );
        if (categoryResult === "created") created.push(category.name);
        else if (categoryResult === "exists") alreadyPresent.push(category.name);
        else {
          foundElsewhere.push(category.name);
          continue;
        }

        categoryId = guild.channels.cache.find(
          (channel) =>
            channel.name === category.name &&
            channel.type === ChannelType.GuildCategory &&
            channel.parentId === null,
        )?.id;

        if (!categoryId) {
          failed.push(`${category.name} (category lookup)`);
          continue;
        }
      } catch {
        failed.push(category.name);
        continue;
      }

      const channelType =
        category.name === "Voice Channels"
          ? ChannelType.GuildVoice
          : ChannelType.GuildText;

      for (const channelName of category.channels) {
        try {
          const result = await ensureSetupChannel(
            guild,
            channelName,
            channelType,
            categoryId,
          );
          const label = `${category.name} / ${channelName}`;
          if (result === "created") created.push(label);
          else if (result === "exists") alreadyPresent.push(label);
          else foundElsewhere.push(label);
        } catch {
          failed.push(`${category.name} / ${channelName}`);
        }
      }
    }

    const summary = [
      `Server setup finished. Created ${created.length} channel${created.length === 1 ? "" : "s"}.`,
      alreadyPresent.length
        ? `Already in place: ${alreadyPresent.length}.`
        : "",
      foundElsewhere.length
        ? `Skipped because a matching name exists in a different location: ${foundElsewhere.join(", ")}.`
        : "",
      failed.length
        ? `Could not create: ${failed.join(", ")}. Check that I have Manage Channels permission.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    await interaction.editReply(summary);
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : "Unknown error" },
      "Discord server setup failed",
    );
    await interaction.editReply(
      `Server setup stopped. Created ${created.length} channel${created.length === 1 ? "" : "s"} before the error. Check the bot's Manage Channels permission and try again.`,
    );
  }
}

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
    for (const guild of readyClient.guilds.cache.values()) {
      void registerGuildCommands(guild).catch((error: unknown) => {
        logger.warn(
          {
            guildId: guild.id,
            error: error instanceof Error ? error.message : "Unknown error",
          },
          "Could not register CocoX.wtf slash commands",
        );
      });
    }
  });

  client.on(Events.GuildCreate, (guild) => {
    void registerGuildCommands(guild).catch((error: unknown) => {
      logger.warn(
        {
          guildId: guild.id,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Could not register CocoX.wtf slash commands",
      );
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    let handler: (() => Promise<void>) | undefined;
    if (
      interaction.commandName === "setup" &&
      interaction.options.getSubcommand() === "server"
    ) {
      handler = () => handleServerSetup(interaction);
    } else if (
      interaction.commandName === "create" &&
      interaction.options.getSubcommand() === "roles"
    ) {
      handler = () => handleCreateRoles(interaction);
    }
    if (!handler) return;

    void handler().catch((error: unknown) => {
      logger.warn(
        {
          error: error instanceof Error ? error.message : "Unknown error",
          guildId: interaction.guildId,
        },
        "Discord slash command failed",
      );
      const response = {
        content: `The /${interaction.commandName} command failed. Check the bot's permissions and try again.`,
        ephemeral: true,
      };
      if (interaction.deferred || interaction.replied) {
        void interaction.editReply(response.content);
      } else {
        void interaction.reply(response);
      }
    });
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
