# CocoX.wtf Discord bot

This bot starts when the API Server workflow starts. It does not post on a timer.

## What it does

- When someone mentions the configured owner account, the bot asks, “What do you need?” and starts a private-to-that-user conversation in the same channel.
- The bot answers that person’s follow-up questions with OpenRouter’s `openrouter/free` model router. The router only selects free models; if none are available, the bot reports that rather than switching to a paid model.
- A message containing the word “Delta” gets the fixed response: “It's working and updated.”
- A person can submit their own public feedback with `!vouch <your own feedback>`. The bot creates a CocoX.wtf-branded image showing the submitter’s Discord username and posts it to the configured vouch channel. It does not invent names or endorsements.
- Server administrators can run `/setup server` to create the channel groups and channels shown in the CocoX.wtf layout. The command skips channels already in the right place and does not change existing channel permissions.
- Conversations expire after 15 minutes without a message. `!stop` ends one early.

## Connect the bot

1. Create a Discord application and bot in the Discord Developer Portal.
2. In the bot settings, enable **Message Content Intent** so the bot can read follow-up questions and `!vouch` submissions.
3. Invite the bot to your server with the `applications.commands` scope and permissions to view channels, send messages, read message history, attach files, and manage channels.
4. Add these values using the project’s secure settings:
   - `DISCORD_BOT_TOKEN` — secret bot token from the Developer Portal.
   - `OPENROUTER_API_KEY` — secret key for your OpenRouter account. Free model availability and rate limits are controlled by OpenRouter.
   - `OWNER_DISCORD_ID` — your Discord user ID (not a secret).
   - `VOUCH_CHANNEL_ID` — optional; defaults to `1563987725168681111`.
5. Start or restart the **API Server** workflow.

Never post bot tokens or API keys in Discord or chat. The bot needs access to the configured vouch channel to publish cards.
