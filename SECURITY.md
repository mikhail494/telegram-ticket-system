# Security Policy

## Supported Versions

Security fixes are supported for the latest released version only.

| Version | Supported |
| --- | --- |
| 1.1.x | Yes |
| 1.0.x | No |

## Reporting a Vulnerability

Do not report suspected security vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting or Security Advisories feature for this repository when it is available. Include a clear description, affected version, reproduction steps, and any relevant impact so the issue can be assessed privately.

## Security Assumptions

- Treat `BOT_TOKEN` as a secret. Never commit it or write it to logs.
- Keep `.env` files local or in deployment secret storage.
- `STAFF_CHAT_ID` is the trusted staff boundary. Anyone able to interact as staff in that configured group can send user replies, change ticket status, close tickets, ban or unban users, and configure Support Logs.
- Run exactly one long-polling bot instance at a time.
- Keep SQLite on persistent, protected storage in production.
- Restrict access to Support Logs because it can contain user support data and transcripts.
- User media is routed through Telegram and is not intentionally duplicated into local application storage.

## Out of Scope / Operational Security

Telegram account and group administration, server or VPS hardening, Railway account security, and backup encryption or retention are deployment-operator responsibilities. This repository does not make guarantees for those controls.
