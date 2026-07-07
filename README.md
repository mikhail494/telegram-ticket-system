# Telegram Support Ticket Bot

Production-ready Telegram support bot for private user support requests and staff replies in Telegram Forum Topics.

Users message the bot in private chat. The bot creates a ticket, creates a dedicated forum topic in the staff supergroup, pins a permanent ticket summary, and copies staff replies from that topic back to the original user.

## Features

- One ticket equals one Telegram forum topic.
- New user tickets create exactly one new topic.
- Follow-up user messages are appended to the same open ticket topic.
- Closed tickets and closed topics are never reused.
- First message in every ticket topic is pinned as a permanent ticket summary.
- User-side `Close ticket` inline button.
- Staff topic controls:
  - Close ticket
  - Mark waiting user
  - Mark in progress
  - Ban user
- Staff commands:
  - `/chatid`
  - `/ticket ID`
  - `/close ID`
  - `/whois`
  - `/ban USER_ID reason`
  - `/unban USER_ID`
  - `/bans`
- Ban list blocks restricted users from opening tickets.
- Media support in both directions:
  - photos
  - documents
  - videos
  - animations
  - audio
  - voice
  - video notes
- SQLite persistence with idempotent schema migrations.
- Railway and Docker deployment support.
- Structured logging with pino.

## Architecture

```text
User private chat
  -> grammY bot
  -> SQLite
  -> Staff supergroup forum topic
  -> Staff topic message copied back to user
```

Core database tables:

- `users`
- `tickets`
- `messages`
- `staff_message_links`
- `banned_users`
- `schema_migrations`

Every ticket stores:

- `user_telegram_id`
- `staff_chat_id`
- `message_thread_id`
- `status`
- timestamps

Routing is based on `message_thread_id`, not on Telegram replies.

## Forum Topics Workflow

Expected lifecycle:

1. User sends a private message to the bot.
2. Bot creates a ticket row.
3. Bot creates one new forum topic in `STAFF_CHAT_ID`.
4. Topic title format:

```text
#123 | @username
```

If username is missing:

```text
#123 | user_123456789
```

5. Bot sends and pins the first topic message:

```text
Ticket #123

User:
@username

Telegram ID:
123456789

Created:
2026-07-07 12:00:00 UTC

Status:
OPEN
```

6. Bot sends the user message into the same topic.
7. Staff writes inside the topic to answer the user.
8. While the ticket is open, later user messages go into the same topic.
9. Closing the ticket marks it `CLOSED` in SQLite and calls `closeForumTopic`.
10. The next user message after close creates a new ticket and a new topic.

Telegram Bot API supports closing individual forum topics. It does not provide a separate archive/hide method for ordinary topics, so the bot closes the topic and never reuses it.

## Telegram Group Configuration

`STAFF_CHAT_ID` must point to a Telegram supergroup with Topics enabled.

To create one:

1. Create a Telegram group.
2. Open group settings.
3. Convert it to a supergroup if Telegram prompts you.
4. Enable Topics.
5. Add the bot.
6. Promote the bot to administrator.

Required bot permissions:

- Manage topics
- Send messages
- Read messages
- Pin messages, recommended for pinned ticket summaries
- Delete messages, optional
- Ban users, optional

The bot needs `Manage topics` for `createForumTopic` and `closeForumTopic`.

## BotFather Setup

1. Message `@BotFather`.
2. Run `/newbot`.
3. Copy the token into `BOT_TOKEN`.
4. Add the bot to the staff supergroup.
5. Promote the bot to admin with the permissions above.

Do not paste the bot token into source code.

## Getting STAFF_CHAT_ID

After the bot is configured for the staff group, run:

```text
/chatid
```

inside the staff group. The bot replies:

```text
Chat ID: -1001234567890
```

Use that value as `STAFF_CHAT_ID`.

For first-time discovery, use Telegram `getUpdates` while the bot is not running, or temporarily test in a known group. After `STAFF_CHAT_ID` is correct, `/chatid` works only in the configured staff group.

## Environment Variables

Create `.env` from `.env.example`:

```bash
BOT_TOKEN=123456:your-bot-token
STAFF_CHAT_ID=-1001234567890
DATABASE_URL=file:./data/support.db
LOG_LEVEL=info
```

Required:

- `BOT_TOKEN`
- `STAFF_CHAT_ID`
- `DATABASE_URL`

Optional:

- `LOG_LEVEL`

`.env` must never be committed.

`.env.example` is safe to commit because it contains placeholders only.

## Local Development

```bash
npm install
npm run build
npm run dev
```

Production run:

```bash
npm start
```

## Railway Deployment

1. Push the repository to GitHub.
2. Create a Railway project from the repository.
3. Add a Railway volume mounted at `/data`.
4. Set Railway variables:
   - `BOT_TOKEN`
   - `STAFF_CHAT_ID`
   - `DATABASE_URL=file:/data/support.db`
   - `LOG_LEVEL=info`
5. Deploy one replica only.

Long polling should not run from multiple replicas.

SQLite needs persistent storage. Without a Railway volume, tickets, messages, bans, and migration state can be lost after rebuilds or restarts.

## Docker

```bash
docker build -t telegram-support-ticket-bot .
docker run --env-file .env -v support-data:/data telegram-support-ticket-bot
```

For Docker with a volume:

```bash
DATABASE_URL=file:/data/support.db
```

## Screenshots

Add screenshots here before public release:

### User Start

Placeholder: private chat `/start` response.

### Ticket Created

Placeholder: user confirmation with `Close ticket` button.

### Staff Topic

Placeholder: staff forum topic with pinned ticket summary.

### Staff Reply

Placeholder: staff reply copied to user.

### Ban Flow

Placeholder: ban button or `/ban` command result.

## Troubleshooting

### Telegram API timeout

Telegram API calls can time out because of network latency or Telegram-side issues. Restart the process, check logs, and make sure only one bot replica is running.

### Wrong STAFF_CHAT_ID

If `STAFF_CHAT_ID` is wrong, staff commands and buttons are ignored outside the configured chat. Confirm the id with `/chatid` in the staff group.

### Bot does not create topics

Check that:

- the staff chat is a supergroup
- Topics are enabled
- the bot is an admin
- the bot has Manage topics permission
- `STAFF_CHAT_ID` starts with `-100`

### Pinned message is not pinned

The bot needs permission to pin messages. Ticket routing still works if pinning fails, but the summary may not stay pinned.

### message_thread_id problems

Each ticket stores `message_thread_id`. If a topic was deleted or becomes unavailable, the bot closes the broken active ticket and creates a fresh ticket on the next user message.

### Duplicate topic creation

The database enforces one active ticket per `user_telegram_id + staff_chat_id`. If simultaneous messages race, the second message waits briefly for the first topic to be created and then appends to it.

### SQLite persistence on Railway

Use:

```bash
DATABASE_URL=file:/data/support.db
```

with a Railway volume mounted at `/data`.

## Security Notes

- `.env` is ignored by git.
- `.env.example` is safe to commit.
- Database files are ignored by git.
- Build artifacts are ignored by git.
- Do not log `BOT_TOKEN`.
- Do not commit real Telegram tokens.
- Restrict staff group access to trusted staff.
- Use one production bot token per deployment.
- Keep Railway variables private.
- User message bodies are stored in SQLite for support history and should not be added to logs.

## Release Checklist

- `npm run build` passes.
- `BOT_TOKEN`, `STAFF_CHAT_ID`, and `DATABASE_URL` are configured.
- Staff group is a supergroup with Topics enabled.
- Bot admin permissions are correct.
- Railway volume is mounted if deploying to Railway.
- No real `.env` or database files are committed.
