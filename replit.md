# CocoX.wtf Discord Bot

A Discord bot that starts AI chats when users mention the configured owner, handles a fixed Delta reply, and posts clearly attributed, user-submitted CocoX.wtf feedback cards on demand.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server and Discord bot (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Bot secrets: `DISCORD_BOT_TOKEN`, `OPENROUTER_API_KEY`
- Bot settings: `OWNER_DISCORD_ID`, optional `VOUCH_CHANNEL_ID` (defaults to `1563987725168681111`)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/lib/discord-bot.ts` — Discord event handling and conversation state
- `artifacts/api-server/src/lib/openrouter.ts` — OpenRouter free-model chat requests
- `artifacts/api-server/src/lib/vouch-card.ts` — branded PNG generation for user-submitted feedback
- `artifacts/api-server/README.md` — Discord setup and bot behavior

## Architecture decisions

- OpenRouter uses the `openrouter/free` router without a paid-model fallback list.
- Vouch cards only use text submitted by the same Discord account named on the card; there is no scheduled posting.
- Chat context is in memory and expires after 15 minutes of inactivity.

## Product

- Mentions of the configured owner begin a conversation with the person who sent the mention.
- The word “Delta” returns the configured status reply without an AI request.
- `!vouch <your own feedback>` posts an attributed card in the vouch channel.

## User preferences

- Keep AI replies on OpenRouter free models, with no paid-model fallback.
- Vouch cards must use text submitted by the attributed Discord user; no fabricated names or scheduled posts.

## Gotchas

- Enable Message Content Intent in the Discord Developer Portal for follow-up messages and vouch submissions.
- The bot remains disconnected until `DISCORD_BOT_TOKEN` is set. Mention-triggered chats also need `OWNER_DISCORD_ID`; general AI answers need `OPENROUTER_API_KEY`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
