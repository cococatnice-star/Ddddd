import {
  AttachmentBuilder,
  Client,
  ChannelType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ApplicationCommandOptionType,
  AuditLogEvent,
  GuildExplicitContentFilter,
  GuildVerificationLevel,
  PermissionFlagsBits,
  Partials,
  SlashCommandBuilder,
  type Guild,
  type ChatInputCommandInteraction,
  type Message,
  type TextChannel,
} from "discord.js";
import { logger } from "./logger";
import { getOpenRouterReply, type OpenRouterChatMessage } from "./openrouter";
import { createVouchCard } from "./vouch-card";

const DEFAULT_VOUCH_CHANNEL_ID = "1563987725168681111";
const HONEY_POT_CHANNEL_NAME = "honey-pot";
const HONEY_POT_WARNING =
  "⚠️ **Honey Pot channel:** Posting here triggers an automatic kick. This channel helps identify suspected spam or compromised accounts. The server owner, admins, and members with the Mod, Moderator, or Owner role are exempt.";
const HONEY_POT_CLEANUP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const HONEY_POT_FETCH_LIMIT_PER_CHANNEL = 100;
const BOT_KICK_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const PROTECTIVE_BOT_NAME_PATTERN =
  /\b(?:anti|guard|protect(?:ion)?|security|moderation|defen[cs]e|safety|helper)\b/;
const SUSPICIOUS_BOT_NAME_RULES = [
  { label: "raid-related name", pattern: /\braid(?:\s*bot|\s*spammer)?\b/ },
  {
    label: "nuke-related name",
    pattern: /\b(?:nuker?|server\s*nuke)(?:\s*bot)?\b/,
  },
  {
    label: "mass-ban/kick/delete name",
    pattern: /\bmass\s*(?:ban|kick|delete)(?:\s*bot)?\b/,
  },
  {
    label: "token-stealing name",
    pattern: /\btoken\s*(?:grabber|stealer)(?:\s*bot)?\b/,
  },
  {
    label: "server-destruction name",
    pattern: /\b(?:server\s*)?destroy(?:er)?(?:\s*bot)?\b/,
  },
  { label: "crasher name", pattern: /\bcrasher(?:\s*bot)?\b/ },
  { label: "spammer name", pattern: /\b(?:spam\s*bot|spammer)(?:\s*bot)?\b/ },
] as const;
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const AI_COOLDOWN_MS = 4_000;
const VOUCH_COOLDOWN_MS = 60_000;
const DEFAULT_BOT_MUTE_DURATION_MS = 19 * 60 * 1000;
const MAX_BOT_MUTE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_DISCORD_MESSAGE_LENGTH = 1_900;
const DELTA_RESPONSE = "It's working and updated.";
const BOT_MUTE_CONTROLLER_IDS = new Set([
  "1153432454980448381",
  "1564108651843682327",
]);
const MUTE_REQUEST_PATTERN =
  /\b(?:stop|mute|quiet|silence|shut\s+up|don't\s+(?:talk|respond|reply)|do\s+not\s+(?:talk|respond|reply)|stay\s+quiet)\b|\b(?:talk|speak|reply)\s+(?:in|after)\b/i;
const UNMUTE_REQUEST_PATTERN =
  /\b(?:unmute|resume|talk\s+again|start\s+talking)\b/i;
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
  .addSubcommand((subcommand) =>
    subcommand
      .setName("honeypot")
      .setDescription("Set up a Honey Pot channel and stronger server protections"),
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

type PendingBotKickRequest = {
  guildId: string;
  botUserId: string;
  botName: string;
  recipientId: string;
  expiresAt: number;
};

type PendingBotKickResolution = {
  request?: PendingBotKickRequest;
  ambiguous: boolean;
};

const conversations = new Map<string, Conversation>();
const lastAiReplyAt = new Map<string, number>();
const lastVouchAt = new Map<string, number>();
const mutedGuilds = new Map<string, number>();
const guildCommandRegistrations = new Map<string, Promise<void>>();
const honeyPotKicksInProgress = new Set<string>();
const pendingBotKickRequests = new Map<string, PendingBotKickRequest>();

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
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: "honeypot",
          description: "Set up a Honey Pot channel and stronger server protections",
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

async function handleHoneyPotSetup(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "Only server administrators can run `/setup honeypot`.",
      ephemeral: true,
    });
    return;
  }

  const requiredPermissions: [string, bigint][] = [
    ["Manage Channels", PermissionFlagsBits.ManageChannels],
    ["Manage Messages", PermissionFlagsBits.ManageMessages],
    ["Kick Members", PermissionFlagsBits.KickMembers],
    ["Manage Server", PermissionFlagsBits.ManageGuild],
    ["Send Messages", PermissionFlagsBits.SendMessages],
    ["Read Message History", PermissionFlagsBits.ReadMessageHistory],
  ];
  const missingPermissions = requiredPermissions
    .filter(([, permission]) => !interaction.appPermissions.has(permission))
    .map(([name]) => name);
  if (missingPermissions.length > 0) {
    await interaction.reply({
      content: `I need these bot permissions first: ${missingPermissions.join(", ")}.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: "Setting up the Honey Pot and raid protections…",
    ephemeral: true,
  });

  try {
    await guild.channels.fetch();
    const existingChannel = guild.channels.cache.find(
      (channel): channel is TextChannel =>
        channel.name === HONEY_POT_CHANNEL_NAME &&
        channel.type === ChannelType.GuildText,
    );
    const textCategory = guild.channels.cache.find(
      (channel) =>
        channel.name === "Text Channels" &&
        channel.type === ChannelType.GuildCategory,
    );
    const honeyPotChannel =
      existingChannel ??
      (await guild.channels.create({
        name: HONEY_POT_CHANNEL_NAME,
        type: ChannelType.GuildText,
        topic:
          "Posting here triggers an automatic kick for non-staff members.",
        ...(textCategory ? { parent: textCategory.id } : {}),
      }));

    const botId = interaction.client.user?.id;
    if (!botId) throw new Error("Discord bot user is unavailable.");

    const recentChannelMessages = await honeyPotChannel.messages.fetch({
      limit: 50,
    });
    const existingWarning = recentChannelMessages.find(
      (message) =>
        message.author.id === botId &&
        message.content === HONEY_POT_WARNING,
    );
    const warningMessage =
      existingWarning ??
      (await honeyPotChannel.send({
        content: HONEY_POT_WARNING,
        allowedMentions: { parse: [] },
      }));
    if (!warningMessage.pinned) await warningMessage.pin();

    await guild.setVerificationLevel(
      GuildVerificationLevel.VeryHigh,
      "CocoX.wtf Honey Pot raid protection setup",
    );
    await guild.setExplicitContentFilter(
      GuildExplicitContentFilter.AllMembers,
      "CocoX.wtf Honey Pot raid protection setup",
    );

    await interaction.editReply(
      `Honey Pot is ready in <#${honeyPotChannel.id}>. I pinned the warning, will kick non-staff who post there, and will try to delete their recent messages across the server. Verification is set to Very High and the content filter to All Members. This adds protection but cannot make a server unraidable.`,
    );
  } catch (error) {
    logger.warn(
      {
        guildId: guild.id,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Honey Pot setup failed",
    );
    await interaction.editReply(
      "Honey Pot setup failed or only partially completed. Check the bot's Manage Channels, Manage Messages, Kick Members, Manage Server, Send Messages, and Read Message History permissions.",
    );
  }
}

function isHoneyPotStaff(
  member: NonNullable<Message["member"]>,
  guild: Guild,
): boolean {
  if (
    member.id === guild.ownerId ||
    member.permissions.has(PermissionFlagsBits.Administrator)
  ) {
    return true;
  }

  const exemptRoleNames = new Set(["mod", "moderator", "owner", "admin"]);
  return member.roles.cache.some((role) =>
    exemptRoleNames.has(role.name.trim().toLocaleLowerCase()),
  );
}

async function deleteRecentMessagesFromUser(
  guild: Guild,
  userId: string,
): Promise<{ deleted: number; failedChannels: number }> {
  const cutoff = Date.now() - HONEY_POT_CLEANUP_WINDOW_MS;
  let deleted = 0;
  let failedChannels = 0;

  try {
    await guild.channels.fetch();
  } catch {
    return { deleted, failedChannels: 1 };
  }

  for (const channel of guild.channels.cache.values()) {
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      continue;
    }

    try {
      const recentMessages = await channel.messages.fetch({
        limit: HONEY_POT_FETCH_LIMIT_PER_CHANNEL,
      });
      const authoredRecentMessages = recentMessages.filter(
        (message) =>
          message.author.id === userId &&
          message.createdTimestamp >= cutoff,
      );
      if (authoredRecentMessages.size === 0) continue;

      const deletedMessages = await channel.bulkDelete(
        authoredRecentMessages,
        true,
      );
      deleted += deletedMessages.size;
    } catch (error) {
      failedChannels += 1;
      logger.debug(
        {
          guildId: guild.id,
          channelId: channel.id,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Could not delete recent Honey Pot offender messages from channel",
      );
    }
  }

  return { deleted, failedChannels };
}

async function handleHoneyPotMessage(message: Message): Promise<boolean> {
  if (!message.guildId) return false;

  const guild = message.guild;
  if (!guild) return false;

  const channel = message.channel;
  const directChannelName = "name" in channel ? channel.name : undefined;
  const parentId = "parentId" in channel ? channel.parentId : null;
  const parentChannelName = parentId
    ? guild.channels.cache.get(parentId)?.name
    : undefined;
  const isHoneyPotTextChannel =
    channel.type === ChannelType.GuildText &&
    directChannelName === HONEY_POT_CHANNEL_NAME;
  const isHoneyPotThread =
    (channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread) &&
    parentChannelName === HONEY_POT_CHANNEL_NAME;
  if (!isHoneyPotTextChannel && !isHoneyPotThread) return false;

  let member = message.member;
  if (!member) {
    try {
      member = await guild.members.fetch(message.author.id);
    } catch (error) {
      logger.warn(
        {
          guildId: message.guildId,
          userId: message.author.id,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Could not check Honey Pot poster roles; skipped kick",
      );
      return true;
    }
  }

  if (isHoneyPotStaff(member, guild)) return true;

  const processingKey = `${message.guildId}:${message.author.id}`;
  if (honeyPotKicksInProgress.has(processingKey)) {
    await message.delete().catch(() => undefined);
    return true;
  }

  honeyPotKicksInProgress.add(processingKey);
  try {
    await message.delete().catch(() => undefined);
    await guild.members.kick(
      message.author.id,
      "Posted in the CocoX.wtf Honey Pot channel",
    );
    const cleanup = await deleteRecentMessagesFromUser(
      guild,
      message.author.id,
    );
    logger.info(
      {
        guildId: message.guildId,
        userId: message.author.id,
        deletedMessages: cleanup.deleted,
        channelsWithCleanupErrors: cleanup.failedChannels,
      },
      "Kicked non-staff Honey Pot poster and cleaned up recent messages",
    );
  } catch (error) {
    logger.warn(
      {
        guildId: message.guildId,
        userId: message.author.id,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Could not kick Honey Pot poster",
    );
  } finally {
    honeyPotKicksInProgress.delete(processingKey);
  }

  return true;
}

function conversationKeyFor(
  guildId: string,
  channelId: string,
  userId: string,
): string {
  return `${guildId}:${channelId}:${userId}`;
}

function conversationKey(message: Message): string {
  return conversationKeyFor(
    message.guildId ?? "dm",
    message.channelId,
    message.author.id,
  );
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

  for (const [guildId, mutedUntil] of mutedGuilds) {
    if (now >= mutedUntil) mutedGuilds.delete(guildId);
  }
}

async function replyWithoutMentions(message: Message, content: string): Promise<void> {
  await message.reply({
    content: trimDiscordMessage(content),
    allowedMentions: { parse: [], repliedUser: false },
  });
}

function stripUserMentions(content: string): string {
  return content.replace(/<@!?\d+>/g, " ").replace(/\s+/g, " ").trim();
}

function formatMuteDuration(durationMs: number): string {
  const units = [
    [7 * 24 * 60 * 60 * 1000, "week"],
    [24 * 60 * 60 * 1000, "day"],
    [60 * 60 * 1000, "hour"],
    [60 * 1000, "minute"],
  ] as const;

  const [unitMs, unitName] =
    units.find(([candidateMs]) => durationMs % candidateMs === 0) ??
    units[units.length - 1];
  const amount = Math.ceil(durationMs / unitMs);
  return `${amount} ${unitName}${amount === 1 ? "" : "s"}`;
}

function parseMuteDuration(commandText: string): {
  durationMs: number;
  label: string;
  capped: boolean;
} {
  const durationMatch = commandText.match(
    /\b(a\s+few|a\s+couple|several|\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b/i,
  );

  if (!durationMatch) {
    return {
      durationMs: DEFAULT_BOT_MUTE_DURATION_MS,
      label: formatMuteDuration(DEFAULT_BOT_MUTE_DURATION_MS),
      capped: false,
    };
  }

  const numberText = durationMatch[1]!.toLowerCase().replace(/\s+/g, " ");
  const numberWords: Record<string, number> = {
    "a few": 3,
    "a couple": 2,
    several: 3,
    a: 1,
    an: 1,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };
  const amount = /^\d+$/.test(numberText)
    ? Number(numberText)
    : numberWords[numberText] ?? 1;
  const unitText = durationMatch[2]!.toLowerCase();
  const unitMs = /^(?:m|min|mins|minute|minutes)$/.test(unitText)
    ? 60 * 1000
    : /^(?:h|hr|hrs|hour|hours)$/.test(unitText)
      ? 60 * 60 * 1000
      : /^(?:d|day|days)$/.test(unitText)
        ? 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
  const requestedDurationMs = amount * unitMs;
  const durationMs = Math.min(
    requestedDurationMs,
    MAX_BOT_MUTE_DURATION_MS,
  );

  return {
    durationMs,
    label: formatMuteDuration(durationMs),
    capped: requestedDurationMs > MAX_BOT_MUTE_DURATION_MS,
  };
}

async function handleMuteControlMessage(
  client: Client,
  message: Message,
): Promise<boolean> {
  const botId = client.user?.id;
  if (!botId || !message.mentions.users.has(botId)) return false;

  const commandText = stripUserMentions(message.content);
  const isController = BOT_MUTE_CONTROLLER_IDS.has(message.author.id);
  if (!isController) return false;

  if (UNMUTE_REQUEST_PATTERN.test(commandText)) {
    const mutedUntil = mutedGuilds.get(message.guildId!);

    if (!mutedUntil || mutedUntil <= Date.now()) {
      mutedGuilds.delete(message.guildId!);
      await replyWithoutMentions(
        message,
        "Bot replies aren't muted for this server right now.",
      );
      return true;
    }

    mutedGuilds.delete(message.guildId!);
    await replyWithoutMentions(
      message,
      "Bot replies are back for everyone in this server.",
    );
    return true;
  }

  if (!MUTE_REQUEST_PATTERN.test(commandText)) return false;

  const duration = parseMuteDuration(commandText);
  const mutedUntil = Date.now() + duration.durationMs;
  mutedGuilds.set(message.guildId!, mutedUntil);
  const guildConversationPrefix = `${message.guildId}:`;
  for (const [key, conversation] of conversations) {
    if (key.startsWith(guildConversationPrefix)) {
      conversation.lastActivityAt = mutedUntil;
    }
  }

  await replyWithoutMentions(
    message,
    `I'll stop replying to everyone in this server, across all channels, for ${duration.label}${duration.capped ? " (the 30-day maximum)" : ""}. An approved account can ping me and say \`unmute\` to resume sooner.`,
  );
  return true;
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
    const mutedUntil = message.guildId
      ? mutedGuilds.get(message.guildId)
      : undefined;
    if (mutedUntil && mutedUntil > Date.now()) return;
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
  if (message.author.bot) return;
  if (await handleHoneyPotMessage(message)) return;
  if (!message.guildId) return;

  pruneExpiredState();

  if (await handleMuteControlMessage(client, message)) return;

  const guildMutedUntil = mutedGuilds.get(message.guildId);
  if (guildMutedUntil && guildMutedUntil > Date.now()) return;

  const key = conversationKey(message);

  if (isVouchCommand(message.content)) {
    await handleVouchCommand(client, message);
    return;
  }

  if (ownerDiscordId && message.mentions.users.has(ownerDiscordId)) {
    conversations.set(key, { messages: [], lastActivityAt: Date.now() });
    await replyWithoutMentions(message, "What do you need? Send your question here and I’ll help.");
    return;
  }

  const conversation = conversations.get(key);
  if (!conversation || !message.content.trim()) return;
  await handleConversationMessage(message, key, conversation);
}

function normalizeBotName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findSuspiciousBotNameRule(
  names: string[],
): (typeof SUSPICIOUS_BOT_NAME_RULES)[number] | undefined {
  for (const name of names) {
    const normalizedName = normalizeBotName(name);
    if (!normalizedName || PROTECTIVE_BOT_NAME_PATTERN.test(normalizedName)) {
      continue;
    }

    const rule = SUSPICIOUS_BOT_NAME_RULES.find(({ pattern }) =>
      pattern.test(normalizedName),
    );
    if (rule) return rule;
  }

  return undefined;
}

async function notifyBotSecurityRecipients(
  client: Client,
  guild: Guild,
  ownerDiscordId: string | undefined,
  content: string,
  pendingKick?: Omit<PendingBotKickRequest, "recipientId" | "expiresAt">,
): Promise<void> {
  const recipientIds = new Set(
    [guild.ownerId, ownerDiscordId, ...BOT_MUTE_CONTROLLER_IDS].filter(
      (id): id is string => Boolean(id && /^\d{17,20}$/.test(id)),
    ),
  );

  for (const recipientId of recipientIds) {
    try {
      const recipient = await client.users.fetch(recipientId);
      const alertMessage = await recipient.send({
        content,
        allowedMentions: { parse: [] },
      });
      if (pendingKick) {
        pendingBotKickRequests.set(alertMessage.id, {
          ...pendingKick,
          recipientId,
          expiresAt: Date.now() + BOT_KICK_APPROVAL_TTL_MS,
        });
      }
    } catch (error) {
      logger.warn(
        {
          guildId: guild.id,
          recipientId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Could not DM a bot security alert recipient",
      );
    }
  }
}

function parseBotSecurityAlertMessage(
  client: Client,
  alertMessage: Message,
  recipientId: string,
): PendingBotKickRequest | undefined {
  if (
    alertMessage.author.id !== client.user?.id ||
    Date.now() - alertMessage.createdTimestamp > BOT_KICK_APPROVAL_TTL_MS ||
    alertMessage.content.includes("so I kicked it.")
  ) {
    return undefined;
  }

  const firstLine = alertMessage.content.split(/\r?\n/, 1)[0] ?? "";
  const match = firstLine.match(
    /^CocoX\.wtf security alert: bot (.+) \(ID (\d{17,20})\) was added to (.+)\.$/,
  );
  if (!match) return undefined;

  const botName = match[1]!;
  const botUserId = match[2]!;
  const alertGuildName = match[3]!;
  const guildIdFromAlert = alertMessage.content.match(
    /^Server ID: (\d{17,20})\.?$/m,
  )?.[1];

  let guildId = guildIdFromAlert;
  if (!guildId || !client.guilds.cache.has(guildId)) {
    const matchingGuilds = client.guilds.cache.filter(
      (guild) => guild.name === alertGuildName,
    );
    if (matchingGuilds.size !== 1) return undefined;
    guildId = matchingGuilds.first()!.id;
  }

  return {
    guildId,
    botUserId,
    botName,
    recipientId,
    expiresAt: alertMessage.createdTimestamp + BOT_KICK_APPROVAL_TTL_MS,
  };
}

async function resolvePendingBotKickRequest(
  client: Client,
  message: Message,
): Promise<PendingBotKickResolution> {
  const now = Date.now();
  for (const [alertMessageId, request] of pendingBotKickRequests) {
    if (request.expiresAt <= now) {
      pendingBotKickRequests.delete(alertMessageId);
    }
  }

  const referencedMessageId = message.reference?.messageId;
  if (referencedMessageId) {
    const pendingRequest = pendingBotKickRequests.get(referencedMessageId);
    if (pendingRequest?.recipientId === message.author.id) {
      return { request: pendingRequest, ambiguous: false };
    }

    if (message.channel.isTextBased()) {
      const referencedMessage = await message.channel.messages
        .fetch(referencedMessageId)
        .catch(() => null);
      if (referencedMessage) {
        const request = parseBotSecurityAlertMessage(
          client,
          referencedMessage,
          message.author.id,
        );
        if (request) return { request, ambiguous: false };
      }
    }
  }

  const inMemoryRequests = [...pendingBotKickRequests.values()].filter(
    (request) =>
      request.recipientId === message.author.id && request.expiresAt > now,
  );
  if (inMemoryRequests.length === 1) {
    return { request: inMemoryRequests[0], ambiguous: false };
  }
  if (inMemoryRequests.length > 1) return { ambiguous: true };

  if (!message.channel.isTextBased()) return { ambiguous: false };
  const recentMessages = await message.channel.messages
    .fetch({ limit: 50 })
    .catch(() => null);
  if (!recentMessages) return { ambiguous: false };

  const historyRequests = new Map<string, PendingBotKickRequest>();
  for (const alertMessage of recentMessages.values()) {
    const request = parseBotSecurityAlertMessage(
      client,
      alertMessage,
      message.author.id,
    );
    if (request) {
      historyRequests.set(`${request.guildId}:${request.botUserId}`, request);
    }
  }

  if (historyRequests.size === 1) {
    return {
      request: historyRequests.values().next().value,
      ambiguous: false,
    };
  }
  return { ambiguous: historyRequests.size > 1 };
}

async function handleBotKickApprovalMessage(
  client: Client,
  message: Message,
  ownerDiscordId: string | undefined,
): Promise<boolean> {
  if (
    message.guildId ||
    !/^(?:kick|kick bot)$/i.test(message.content.trim())
  ) {
    return false;
  }

  const resolution = await resolvePendingBotKickRequest(client, message);
  if (resolution.ambiguous) {
    await message.reply(
      'More than one bot alert is waiting. Reply directly to the specific alert with `kick`.',
    );
    return true;
  }
  const request = resolution.request;
  if (!request) {
    await message.reply(
      'I could not match that to a recent bot alert. Reply directly to the alert with `kick`.',
    );
    return true;
  }

  const guild = client.guilds.cache.get(request.guildId);
  if (!guild) {
    await message.reply(
      "I can't access that server anymore, so I couldn't kick the bot.",
    );
    return true;
  }
  if (
    message.author.id !== guild.ownerId &&
    message.author.id !== ownerDiscordId &&
    !BOT_MUTE_CONTROLLER_IDS.has(message.author.id)
  ) {
    await message.reply(
      "Only the server owner and approved security controllers can approve this kick.",
    );
    return true;
  }

  let targetUser;
  try {
    targetUser = await client.users.fetch(request.botUserId);
  } catch {
    await message.reply(
      "I couldn't verify that bot account, so I didn't kick anything.",
    );
    return true;
  }
  if (!targetUser.bot) {
    await message.reply(
      "That account is not a bot, so I won't kick it with this approval.",
    );
    return true;
  }

  try {
    await guild.members.kick(
      request.botUserId,
      `Kick approved by ${message.author.id} from a CocoX.wtf security alert`,
    );
    for (const [alertMessageId, pendingRequest] of pendingBotKickRequests) {
      if (
        pendingRequest.guildId === request.guildId &&
        pendingRequest.botUserId === request.botUserId
      ) {
        pendingBotKickRequests.delete(alertMessageId);
      }
    }
    await message.reply(
      `Removed ${request.botName} from ${guild.name}.`,
    );
  } catch (error) {
    logger.warn(
      {
        guildId: guild.id,
        botUserId: request.botUserId,
        approverId: message.author.id,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Could not complete an approved bot kick",
    );
    await message.reply(
      "I couldn't kick that bot. It may have already left, or I may need Kick Members permission and a higher role.",
    );
  }

  return true;
}

async function handleBotAddAuditEntry(
  client: Client,
  guild: Guild,
  botUserId: string,
  addedById: string | null,
  ownerDiscordId: string | undefined,
): Promise<void> {
  let botUser;
  try {
    botUser = await client.users.fetch(botUserId);
  } catch (error) {
    logger.warn(
      {
        guildId: guild.id,
        botUserId,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      "Could not fetch a newly added bot account",
    );
  }

  if (botUser && !botUser.bot) return;

  const matchedRule = botUser
    ? findSuspiciousBotNameRule([botUser.username, botUser.globalName ?? ""])
    : undefined;
  let kicked = false;
  let kickError: string | undefined;

  if (matchedRule) {
    try {
      await guild.members.kick(
        botUserId,
        `New bot name matched suspicious pattern: ${matchedRule.label}`,
      );
      kicked = true;
    } catch (error) {
      kickError =
        error instanceof Error ? error.message : "Unknown kick error";
      logger.warn(
        {
          guildId: guild.id,
          botUserId,
          matchedRule: matchedRule.label,
          error: kickError,
        },
        "Could not kick a bot with a suspicious name",
      );
    }
  }

  const botName = botUser?.username ?? "unknown name";
  const result = !botUser
    ? "I could not read its username, so I did not auto-kick it."
    : matchedRule
      ? kicked
        ? `Its name matched the ${matchedRule.label} rule, so I kicked it.`
        : `Its name matched the ${matchedRule.label} rule, but the kick failed. Check my Kick Members permission and role position.`
      : "No high-confidence suspicious-name rule matched, so I left it in the server for review.";
  const alert = [
    `CocoX.wtf security alert: bot ${botName} (ID ${botUserId}) was added to ${guild.name}.`,
    `Server ID: ${guild.id}.`,
    `Added by user ID: ${addedById ?? "unknown"}.`,
    result,
    "Name matching is a heuristic; it cannot confirm whether an account is malicious.",
  ];
  const pendingKick = kicked
    ? undefined
    : {
        guildId: guild.id,
        botUserId,
        botName,
      };
  if (pendingKick) {
    alert.push(
      'Reply to this DM with `kick` to remove this bot. Only the server owner and approved security controllers can approve it.',
    );
  }

  await notifyBotSecurityRecipients(
    client,
    guild,
    ownerDiscordId,
    alert.join("\n"),
    pendingKick,
  );
  logger.info(
    {
      guildId: guild.id,
      botUserId,
      addedById,
      matchedRule: matchedRule?.label,
      kicked,
      kickError,
    },
    "Processed a bot-add audit entry",
  );
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
      GatewayIntentBits.GuildModeration,
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

  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    if (entry.action !== AuditLogEvent.BotAdd || !entry.targetId) return;

    void handleBotAddAuditEntry(
      client,
      guild,
      entry.targetId,
      entry.executorId,
      ownerDiscordId,
    ).catch((error: unknown) => {
      logger.warn(
        {
          guildId: guild.id,
          botUserId: entry.targetId,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "Could not process a bot-add security event",
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
      interaction.commandName === "setup" &&
      interaction.options.getSubcommand() === "honeypot"
    ) {
      handler = () => handleHoneyPotSetup(interaction);
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
