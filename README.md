# Telegram Support Ticket Bot

A production-ready Telegram support ticket bot built with Node.js 20, TypeScript, grammY, SQLite, better-sqlite3, and dotenv.

Users message the bot in private chat. The bot creates or updates a support ticket, posts it to a private staff Telegram group, and forwards staff replies back to the original user from the bot account.

## Features

- Private-chat ticket intake with `/start`
- SQLite storage for users, tickets, messages, and staff message mappings
- One active ticket per user; new user messages are appended to the existing active ticket
- Staff replies in the staff group are delivered back to the user
- Staff photo/document/media replies are copied back to users
- User photos/documents are copied into the staff ticket reply chain
- Inline staff buttons: close, waiting user, in progress
- User commands: `/status`, `/mytickets`
- Staff commands: `/ticket ID`, `/close ID`
- Error logging with pino and staff-group delivery failure notices
- Dockerfile and Railway-ready config

## Project Structure

```text
.
|-- src
|   |-- bot.ts        # grammY handlers and ticket flow
|   |-- config.ts     # dotenv + environment validation
|   |-- db.ts         # SQLite schema, migrations, and prepared statements
|   |-- format.ts     # user/staff message formatting
|   |-- index.ts      # app entrypoint
|   |-- logger.ts     # pino logger
|   `-- telegram.ts   # Telegram message/user helpers
|-- Dockerfile
|-- railway.json
|-- package.json
|-- tsconfig.json
`-- .env.example
```

## Environment

Create `.env` from `.env.example`:

```bash
BOT_TOKEN=123456:your-bot-token
STAFF_CHAT_ID=-1001234567890
DATABASE_URL=file:./data/support.db
LOG_LEVEL=info
```

`STAFF_CHAT_ID` must be the private staff group or supergroup id. For Railway with a persistent volume mounted at `/data`, use:

```bash
DATABASE_URL=file:/data/support.db
```

## BotFather Setup

1. Open Telegram and message `@BotFather`.
2. Run `/newbot` and copy the bot token into `BOT_TOKEN`.
3. Add the bot to your private staff group.
4. Keep BotFather privacy mode enabled or disable it; this bot only needs commands and replies to its own ticket messages in the staff group.
5. Make sure staff reply directly to the bot's ticket message or to messages in that ticket reply chain.

To find `STAFF_CHAT_ID`, add the bot to the staff group, send a message in the group, then temporarily run the bot locally and check logs or call Telegram `getUpdates` while the bot is not running.

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Build and run:

```bash
npm run build
npm start
```

## Staff Workflow

When a user sends a private message, staff receive:

```text
New ticket #ID
From: @username
User ID: telegram_id
Status: OPEN
Message: user message

Reply to this message to answer the user.
```

Staff can:

- Reply to the ticket message to answer the user
- Reply with text, photo, document, or other copyable Telegram media
- Click `Close ticket`, `Mark waiting user`, or `Mark in progress`
- Run `/ticket ID` to view details and recent messages
- Run `/close ID` to close a ticket

When a ticket is closed, the user receives:

```text
Your ticket has been closed. If you still need help, send a new message.
```

## Railway Deployment

1. Push this project to GitHub.
2. Create a new Railway project from the repository.
3. Railway will use the included `Dockerfile` and `railway.json`.
4. Add variables:
   - `BOT_TOKEN`
   - `STAFF_CHAT_ID`
   - `DATABASE_URL=file:/data/support.db`
   - `LOG_LEVEL=info`
5. Add a Railway volume mounted at `/data`.
6. Deploy one replica only. Long polling should not run from multiple instances at the same time.

SQLite needs persistent storage. Without a Railway volume, tickets will be lost when the container is rebuilt or restarted on a fresh filesystem.

## Docker

```bash
docker build -t telegram-support-ticket-bot .
docker run --env-file .env -v support-data:/data telegram-support-ticket-bot
```

For Docker with the volume above, set:

```bash
DATABASE_URL=file:/data/support.db
```

## Notes

- The bot accepts new tickets only in private chats.
- Random group messages are ignored unless they are replies to known ticket messages in `STAFF_CHAT_ID`.
- The database schema is created automatically on startup.
- No secrets are hardcoded; all runtime configuration comes from environment variables.
