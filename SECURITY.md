# Security Policy

## Supported Versions

Security fixes are supported for the latest released version only.

| Version         | Supported |
| --------------- | --------- |
| 1.4.x           | Yes       |
| 1.3.x and older | No        |

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

## Dependency Vulnerability Triage

`npm run security:audit` runs `npm audit --omit=dev --audit-level=high`. CI runs it immediately after `npm ci`, so known HIGH or CRITICAL vulnerabilities in the production dependency tree block the build. LOW and MODERATE findings do not automatically block this production-runtime gate. Development-only findings still require supply-chain and CI/build impact review, but do not automatically imply a production runtime compromise.

- Treat a CRITICAL runtime vulnerability as urgent: assess exploitability immediately and patch or mitigate before ordinary release work where practical.
- HIGH runtime findings block CI and should be patched promptly.
- Review MODERATE and LOW findings during normal maintenance unless their exploitability changes the priority.
- Do not use `npm audit fix --force` blindly. Review release notes, regenerate the lockfile only intentionally, and run the full validation and Docker build after dependency changes.

Dependabot checks npm, GitHub Actions, and the Docker base image weekly. Security updates are reviewed separately; there is no automatic merge. The `@types/node` major-version ignore keeps the supported Node 24 type baseline deliberate rather than silently changing it.

## Data at Rest Decision

The SQLite database and backups contain Telegram IDs and usernames, ticket metadata and message content, support bans, Batch state, installation/workspace and team state, hashed secure-token records, and moderation/adaptive-learning state. Support Logs exports and temporary transcripts are also sensitive while they exist.

Application-level SQLite encryption would reduce exposure from a stolen raw database or backup only when its key is separately protected. It does not protect against a compromised running process, root/VPS compromise, a leaked bot token, repository compromise, or an attacker with access to both the host filesystem and the application key. Adding it now would also add key-management, backup/restore, recovery, and key-loss failure modes to this single-VPS deployment.

Decision: **DEFER** application-level encryption at rest. Repository-level confidentiality and access controls include restrictive POSIX filesystem modes, the Docker image running as the non-root `node` user, and log redaction. Host service-account selection and host access control outside that container model remain deployment-operator responsibilities. Checksum verification and restore verification provide integrity and recoverability, not confidentiality. Reconsider when backups leave a trusted host or move to third-party/object storage, operators no longer share full host trust, the system becomes multi-tenant, a regulatory/data-classification requirement applies, or centralized key management becomes available.

- **Another unprivileged local user:** restrictive database and backup permissions are the relevant protection; application encryption is not required to enforce that boundary.
- **Stolen database, backup, or provider snapshot:** encryption can help only with separately managed keys; same-host local backups remain a host-security responsibility.
- **Compromised application process or root/VPS:** neither application encryption nor filesystem modes protect data already accessible to that process or host administrator.
- **Repository compromise:** protect bot tokens, deployment credentials, and dependency review; database encryption does not prevent a malicious deployed application from reading its own data.
- **Telegram/API token compromise:** rotate/revoke the token and assess Telegram-side access; SQLite encryption does not mitigate API impersonation.

## Build Supply Chain

CI pins `actions/checkout` and `actions/setup-node` to reviewed immutable commit SHAs, with the corresponding release versions documented beside each workflow reference. Dependabot continues to monitor GitHub Actions so those pins can be updated intentionally through reviewed pull requests. `actions/checkout` also runs with persisted Git credentials disabled after checkout.

The Dockerfile pins the official multi-platform `node:24-bookworm-slim` image index by digest. The npm lockfile pins JavaScript packages, not operating-system layers or the Node base image; Dependabot monitors the Docker dependency so image updates remain reviewed through normal build and runtime validation.

## Filesystem Permissions

On POSIX, newly created database directories use mode `0700`; new database files are created with `0600`, and any WAL/SHM artifacts present during startup are restricted to `0600`. The restricted parent directory protects later SQLite sidecar recreation for the default managed path. Managed backup directories are created with `0700`, and published backup, checksum, and temporary metadata files use `0600`. Existing operator-provided directories retain their ownership and must be restricted to the service account. Windows ACLs remain the deployment boundary because POSIX mode bits are not authoritative there.

These controls do not protect against root, a compromised application process, equivalent filesystem credentials, or a stolen host snapshot. Keep the database path, backup directory, and any host-level snapshot storage access-controlled.

## Out of Scope / Operational Security

Telegram account and group administration, operating-system or VPS hardening, firewall and reverse-proxy policy, host access control, and backup encryption or off-host retention are deployment-operator responsibilities. This repository does not make guarantees for those controls.
