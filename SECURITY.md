# Security Policy

## Supported Versions

Security fixes are supported for the latest released version only.

| Version | Supported |
| --- | --- |
| 1.4.x | Yes |
| 1.3.x and older | No |

## Reporting a Vulnerability

Do not report suspected security vulnerabilities through public GitHub issues.

Use GitHub's private vulnerability reporting or Security Advisories feature for this repository when available. Include a clear description, affected version, reproduction steps, and relevant impact so the issue can be assessed privately.

## Security Assumptions

- Treat `BOT_TOKEN` as a secret. Never commit it or expose it in logs, screenshots, issue reports, or support exports.
- Keep `.env` files local or in deployment secret storage.
- OWNER pairing and recovery links are expiring, one-use credentials. Generate them only through the documented interactive commands and keep the terminal output private.
- In role-based mode, staff actions require both active application authorization and membership in the configured staff workspace. Telegram administrator status alone is not an application role.
- Run exactly one long-polling bot instance for a deployment at a time.
- Keep SQLite and its backups on persistent, access-controlled storage in production.
- Treat Support Logs, ticket exports, answer packages, transcripts, and database backups as sensitive support data.
- Native operational HTTP is disabled by default. If `/healthz`, `/readyz`, or `/metrics` are enabled or exposed outside localhost, protect them with network controls or a trusted reverse proxy.
- User media is routed through Telegram and is not intentionally duplicated into long-term application storage, except when explicitly embedded in operator-requested ticket exports.

## Out of Scope / Operational Security

Telegram account and group administration, operating-system or VPS hardening, firewall and reverse-proxy policy, host access control, and backup encryption or off-host retention are deployment-operator responsibilities. This repository does not make guarantees for those controls.
