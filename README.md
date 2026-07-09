# Telegram Support Ticket Bot

Production-ready Telegram support bot built with Node.js 20, TypeScript, grammY, SQLite, better-sqlite3, and dotenv.

Users message the bot in private chat. The bot creates a support ticket, creates one Telegram forum topic for that ticket, lets staff answer from the topic, and archives the final transcript into a dedicated Support Logs topic when the ticket is closed.

Version: `1.0.1`

## Features

- Private user intake with `/start`.
- Context-aware `/help` for users and staff.
- One active ticket per user per configured staff chat.
- One ticket equals one Telegram forum topic.
- Follow-up user messages append to the same open ticket topic.
- Closed tickets and closed topics are never reused.
- Pinned ticket summary inside every ticket topic.
- Staff controls: close, waiting user, in progress, ban user.
- User-side `Close ticket` button.
- Staff commands: `/help`, `/chatid`, `/ticket`, `/close`, `/whois`, `/logs`, `/setlogs`, `/ban`, `/unban`, `/bans`.
- Ban and unban events are logged.
- Staff replies are copied to users without internal staff signatures.
- Media support: photos, documents, videos, animations, audio, voice, video notes.
- Dedicated `📜 Support Logs` forum topic for archive events.
- Transcript file upload on ticket close.
- Temporary SQLite conversation storage while a ticket is active.
- Conversation message bodies are removed from SQLite after successful transcript upload.
- Idempotent SQLite migrations for upgrades.
- Docker and Railway deployment support.

## Architecture

```text
User
  |
  v
Bot
  |
  v
SQLite (temporary)
  |
  v
Forum Topic
  |
  v
Support Logs
```

Runtime components:

- `grammY` handles Telegram updates and Bot API calls.
- SQLite stores users, tickets, temporary messages, bans, settings, and migration state.
- Each ticket topic is the live staff workspace.
- `📜 Support Logs` is the durable Telegram archive for closure transcripts and ban events.

## Forum Topics Workflow

`STAFF_CHAT_ID` must be a Telegram supergroup with Topics enabled.

Ticket lifecycle:

1. User sends a private message to the bot.
2. Bot creates one ticket row.
3. Bot creates exactly one forum topic for that ticket.
4. Topic name format:

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
2026-07-07 14:00:00 UTC

Status:
OPEN
```

6. Staff writes inside the ticket topic to answer the user.
7. While the ticket is open, every new user message is appended to the same topic.
8. Closing the ticket marks it `CLOSED`.
9. The next user message creates a brand new ticket and a brand new topic.
10. Closed topics are never reused.

Routing is based on `message_thread_id`, not reply chains.

## Support Logs Workflow

The bot manages one dedicated forum topic:

```text
📜 Support Logs
```

This topic is for archive events only.

On startup the bot:

- reads the stored Support Logs `message_thread_id` for the current `STAFF_CHAT_ID` from SQLite;
- verifies the topic with a silent chat action;
- reopens it if it was closed;
- creates a new Support Logs topic only if the stored topic is missing or deleted;
- stores the new `message_thread_id` scoped to the current `STAFF_CHAT_ID`.

The bot does not create a new logs topic on every restart.

Support Logs settings are scoped per staff chat. If you change `STAFF_CHAT_ID`, the bot does not reuse a topic id from the old group. It creates or reuses a Support Logs topic for the new group only.

### Staff Logs Commands

Use `/logs` in the configured staff group to show the current Support Logs thread id and its status. If no Support Logs topic exists for the current `STAFF_CHAT_ID`, the bot creates one automatically and reports the new thread id.

Use `/setlogs` inside any forum topic in the configured staff group to manually choose that topic as Support Logs. The bot replies:

```text
This topic is now used as Support Logs.
```

If `/setlogs` is used outside a forum topic, the bot replies:

```text
Please run /setlogs inside the forum topic you want to use as Support Logs.
```

Automatic behavior still works without staff input. Manual override is only for teams that want to choose an existing logs topic.

## Help And Staff Onboarding

`/help` is context-aware.

In private chat, `/help` explains how users open tickets, how the single active ticket works, how to keep sending updates, how to close a ticket, and how a new message after closure opens a new ticket.

In the configured staff group, including ticket topics, `/help` explains the forum topic workflow, Support Logs behavior, archive behavior, and all staff commands.

On startup, the bot sends one onboarding/help message to the main topic of the configured `STAFF_CHAT_ID` the first time it sees that staff chat. The message confirms setup, summarizes the workflow, lists staff commands, and explains `/setlogs` and `/logs`.

The onboarding flag is stored in SQLite as a setting scoped per staff chat:

```text
staff_help_sent:<STAFF_CHAT_ID> = true
```

Changing `STAFF_CHAT_ID` allows the new staff group to receive its own one-time onboarding message. If Telegram rejects the onboarding message, the bot logs the error and keeps running; staff can still use `/help` manually.

## Commands

User/private:

- `/start` - start the bot and get initial instructions.
- `/status` - show latest ticket status.
- `/mytickets` - show latest tickets.
- `/help` - show user help.
- `Close ticket` button - close the current open ticket.

Staff/group:

- `/help` - show staff help.
- `/chatid` - show current chat id.
- `/whois` - show current ticket/user info inside a ticket topic.
- `/ticket <id>` - show ticket details.
- `/close <id>` - close ticket.
- `/ban <telegram_id> [reason]` - ban user from opening tickets.
- `/unban <telegram_id>` - unban user.
- `/bans` - list banned users.
- `/setlogs` - use current topic as Support Logs.
- `/logs` - show or create current Support Logs topic status.

## Transcript Workflow

While a ticket is active, SQLite temporarily stores conversation messages:

- ticket id
- sender type
- sender display name
- sender username
- text
- media type
- document filename
- timestamp

When a ticket is closed by staff, user, or ban flow:

1. The ticket is marked `CLOSED`.
2. A temporary file is generated:

```text
ticket-123-transcript.txt
```

3. The bot sends one closure summary to `📜 Support Logs`.
4. The bot uploads the transcript file immediately below the summary.
5. SQLite stores the logs message id and transcript message id.
6. SQLite deletes the temporary conversation messages for that ticket.
7. The transcript file is deleted from disk.
8. The bot attempts to delete the ticket topic. If deletion is unavailable, it attempts to close the topic.

Media is represented in transcripts as text only:

```text
Attachment: photo
Attachment: video
Attachment: voice
Attachment: animation
Attachment: document: filename.pdf
```

Media files are not duplicated into Support Logs.

If transcript upload fails:

- temporary SQLite messages are kept;
- the temporary file is removed from disk;
- the failure is logged;
- the bot retries pending closed-ticket archives on the next restart.

## Database Cleanup

SQLite is not the permanent conversation archive.

After successful transcript upload, the bot deletes message bodies and media ids from the `messages` table by deleting the temporary message rows for that ticket.

The ticket metadata remains:

- ticket id
- Telegram user id
- username
- timestamps
- final status
- ticket topic id
- Support Logs summary message id
- transcript document message id

## Telegram Setup

Create a staff supergroup:

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
- Pin messages
- Delete messages, recommended for deleting archived ticket topics
- Ban users, optional if staff use Telegram bans separately

The bot needs `Manage topics` for creating, reopening, closing, and deleting forum topics.

## BotFather Setup

1. Message `@BotFather`.
2. Run `/newbot`.
3. Copy the token.
4. Put the token in `BOT_TOKEN`.
5. Do not paste the token into source code.

## Getting STAFF_CHAT_ID

After the bot is running and added to the staff group, run:

```text
/chatid
```

inside the configured staff group.

The bot replies:

```text
Chat ID: -1001234567890
```

Use that value as `STAFF_CHAT_ID`.

`/chatid` is staff-only and does not work in private chat.

## Environment Variables

Create `.env` from `.env.example`:

```bash
BOT_TOKEN=123456:your-bot-token
STAFF_CHAT_ID=-1001234567890
DATABASE_URL=file:./data/support.db
LOG_LEVEL=info
```

Required Railway variables:

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
3. Use the included Dockerfile.
4. Add a Railway volume mounted at `/data`.
5. Set variables:
   - `BOT_TOKEN`
   - `STAFF_CHAT_ID`
   - `DATABASE_URL=file:/data/support.db`
   - `LOG_LEVEL=info`
6. Deploy one replica only.

Long polling must not run from multiple replicas at the same time.

SQLite needs persistent storage. Without a Railway volume, tickets, bans, settings, and migration state can be lost after restarts.

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

Add screenshots here before public release.

### User Start

Placeholder: private chat `/start` response.

### Ticket Topic

Placeholder: staff ticket topic with pinned summary.

### Staff Reply

Placeholder: staff reply copied to user without internal staff signature.

### Support Logs

Placeholder: closure summary and transcript attachment.

### Ban Flow

Placeholder: ban event in Support Logs.

## Troubleshooting

### Telegram API timeout

Check network stability, restart the process, and make sure only one bot replica is running.

### Wrong STAFF_CHAT_ID

Staff commands and callbacks are accepted only in `STAFF_CHAT_ID`. Confirm the id with `/chatid`.

### Bot does not create ticket topics

Check that:

- the staff chat is a supergroup;
- Topics are enabled;
- the bot is an admin;
- the bot has Manage topics permission;
- `STAFF_CHAT_ID` starts with `-100`.

### Bot does not create Support Logs

Check Manage topics permission and confirm the bot can send messages in the staff group.

### Pinned summary is not pinned

The bot needs permission to pin messages. Ticket routing still works if pinning fails.

### Transcript upload fails

The bot keeps temporary messages in SQLite and retries pending closed-ticket archives on restart. Check that the bot can send documents in the staff group.

If Telegram reports `message thread not found`, `topic not found`, or `chat not found` for Support Logs, the bot creates a fresh `📜 Support Logs` topic for the current `STAFF_CHAT_ID`, saves the new thread id, and retries the archive upload once.

### Archived topics are not deleted

The bot first calls `deleteForumTopic`. If Telegram rejects that action, it falls back to `closeForumTopic`. Grant Delete messages permission if you want full topic deletion.

### SQLite persistence on Railway

Use:

```bash
DATABASE_URL=file:/data/support.db
```

with a Railway volume mounted at `/data`.

## Security Recommendations

- Never commit `.env`.
- Keep `BOT_TOKEN` only in local env files or Railway variables.
- Do not log bot tokens.
- Restrict the staff group to trusted staff.
- Deploy one bot replica.
- Keep SQLite on persistent storage.
- Treat Support Logs as the permanent support archive.
- Do not download or duplicate user media into app storage.
- Review staff access before making the repository public.

## Release Checklist

- `npm run build` passes.
- Staff group is a supergroup with Topics enabled.
- Bot has Manage topics, Send messages, Read messages, Pin messages, and preferably Delete messages.
- `BOT_TOKEN`, `STAFF_CHAT_ID`, and `DATABASE_URL` are configured.
- Railway volume is mounted if deploying to Railway.
- `.env`, database files, `dist`, and `node_modules` are ignored by git.
