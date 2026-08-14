# Changelog

All notable changes to this project are documented in this file. This project follows the Keep a Changelog format and Semantic Versioning conventions.

## [Unreleased]

### Added

- Verified SQLite online backups with safe retention, restore verification tooling, and an operational restore drill.
- Secret-safe runtime logging and an explicit interactive OWNER pairing command.
- Graceful shutdown lifecycle draining for Telegram polling, tracked durable background work, and active SQLite backups.
- In-memory per-customer private-message anti-flood protection that keeps legitimate support bursts permissive without creating bans or durable abuse records.
- Lightweight operational HTTP health, readiness, and process metrics endpoints with native opt-in configuration.

### Fixed

- Kept existing automatic role-based access behavior unchanged for READY installations after OWNER pairing and startup.
- Removed per-attempt SQLite backup WAL/SHM temporary sidecars after successful backup publication without rolling back a finalized backup if cleanup fails.
- Kept finalized managed SQLite backups immutable during validation and cleaned exact legacy SQLite sidecars only when their managed backup ages out through retention.

### Changed

- Ticket Batch exports now represent the known hosted Telegram Bot API oversized-file limitation as explicit unavailable attachment metadata instead of aborting the whole archive.
- OWNER and ADMIN can configure the expected response-time text and complete new-ticket acknowledgement shown when a ticket is created.
- Test-ticket mode now retires its prompt after consumption and returns the operator to a fresh dashboard after a test ticket closes.
- Docker runtime now runs as the non-root `node` user with persistent `/data` defaults and readiness-based health checking.

## [1.3.0] - 2026-08-09

### Added

- Guided self-hosted setup with OWNER pairing, recovery, and Telegram-native staff-workspace selection.
- Application roles for OWNER, ADMIN, SENIOR_AGENT, and AGENT, with automatic role-based access for READY installations with an OWNER.
- Management of multiple public Telegram chats with independent moderation configuration.
- Topic-aware moderation warnings for forum supergroups.
- Private OWNER/ADMIN ticket export and answer-package Apply workflows.

### Changed

- Existing installations adopt the workspace, Support Logs, moderation state, tickets, archives, batch state, and sanctions without changing them during adoption.
- RBAC-active staff-chat batch commands now redirect privileged operations to private chat.

### Database

- Added migrations 20 and 21 for installation onboarding and per-public-chat moderation state.

## [1.2.7] - 2026-08-09

### Fixed

- Made `reply_and_close` recovery resume close and archive work after transient staff-topic delivery failures.
- Prevented post-delivery recovery from resending already delivered user replies.
- Reconciled stale batch-item states after post-reply work completes.
- Separated reply delivery from close/archive completion in batch summaries.
- Improved forum-topic cleanup diagnostics without claiming unverified Telegram topic state.

## [1.2.6] - 2026-08-02

### Fixed

- Replaced unsupported moderation reactions with Telegram-compatible reactions.
- Added durable per-message cleanup state for moderated messages.
- Prevented failed deletions from being marked as completed.
- Added restart-safe recovery for pending moderation cleanup.
- Bound cleanup jobs to exact moderation cycles.
- Fixed repeated permanent-ban cleanup after a manual Telegram unban.
- Prevented duplicate Support Logs events during cleanup retries.

### Database

- Added migrations 18 and 19 for durable cleanup state and exact moderation-cycle binding.

## [1.2.5] - 2026-08-02

### Fixed

- Separated `no_action` accounting from staff-topic synchronization.
- Reported terminal staff synchronization failures independently from user-delivery outcomes.
- Prevented terminal and inert staff events from remaining startup-recovery candidates indefinitely.
- Preserved internal follow-up context when a Telegram topic event cannot be delivered.
- Prevented staff synchronization failures from causing duplicate user replies.
- Added regression coverage for batch actions, delivery isolation, topic events, and final summaries.

## [1.2.4] - Unreleased

### Fixed

- Made batch Apply final summaries durable and retryable.
- Prevented staff-chat rate limiting from leaving packages visibly stuck on Applying.
- Added bounded retry-after handling and per-staff-chat coordination for staff-only batch operations.
- Added startup recovery for pending batch summaries and staff topic events without retrying user delivery.
- Preserved durable item outcomes while staff-side synchronization is pending.
- Enabled pending package summaries to finalize without repeating user actions.
- Excluded contradictory success echoes for failed user deliveries and normalized stale legacy echo state during migration.
- Added defensive recovery eligibility checks so success and failure events cannot be emitted for the same delivery attempt.

## [1.2.3] - Unreleased

### Fixed

- Preserved sanitized Telegram delivery diagnostics for batch replies.
- Distinguished permanent, temporary, and unknown delivery outcomes.
- Added idempotent staff-only failure events in ticket topics.
- Prevented terminal batch failures from being retried automatically.
- Made Apply summary delivery independent from preview cleanup.
- Invalidated stale preview controls before Apply and included delivery-failure context in future exports.

## [1.2.2] - Unreleased

### Fixed

- Added visible ticket-topic records for batch replies.
- Added persistent follow-up state, internal notes, and escalation targets.
- Included internal follow-up context in ticket exports.
- Prevented consecutive exports from losing prior staff replies or generating duplicate answers.
- Preserved idempotent user delivery and close/archive recovery.

## [1.2.1] - Unreleased

### Fixed

- Replaced per-attachment staff-chat copies with one self-contained ticket export archive.
- Embedded complete ticket text, metadata, and media into a portable ZIP for offline processing.
- Added deterministic ticket/message media mapping through archive paths and a media index.
- Added human-readable ticket context, answer-package instructions, and a machine-readable answer schema.
- Replaced multi-message answer previews with one paginated editable preview message.
- Added preview deletion on Apply and Cancel and prevented per-ticket preview and Apply progress spam.
- Added strict export completeness validation, delivery-state tracking, and per-staff-chat export locking.
- Preserved deterministic preview validation and idempotent answer execution.

## [1.2.0] - Unreleased

### Added

- Deterministic active-ticket exports and answer-package preview, validation, and idempotent Apply operations.
- `reply_keep_open` and `reply_and_close` answer actions, reusing existing ticket delivery, transcript, close, archive, and Support Logs paths.
- Best-effort Telegram attachment mapping for ticket batch exports.
- Configurable English-only public-chat moderation with a conservative local classifier, persistent strikes, grouped warnings, suppression, and staff controls.
- A 24-hour mute, 7-day mute, and permanent-ban sanction ladder with delayed cleanup, restart recovery, and Support Logs integration.
- A generic created-entity notification foundation with deterministic quest rendering, persistent publication deduplication, provider registry, and `/questnotify` controls.
- SQLite migrations 8 through 12 and expanded regression coverage for ticket batches, moderation, and entity notifications.

### Changed

- Ticket batch operations block stale tickets and keep Apply idempotent.
- Public-chat moderation remains isolated from private-support ticket bans.
- Entity notifications use a configurable provider interface and require an authoritative available provider before publication.
- Existing ticket, Quick Reply, archive, Support Logs, and moderation behavior remains backward compatible.

## [1.1.0] - 2026-07-18

### Added

- Staff Quick Replies system for active ticket topics.
- JSON-configured Quick Reply categories and response templates.
- Category navigation, Back, Cancel, and template pagination.
- Quick Reply transcript integration.
- Automated test infrastructure using `node:test` and `tsx`.
- 66 automated tests covering Quick Replies, staff replies, and Support Logs safety.

### Changed

- Refactored staff text delivery to use one shared delivery and transcript-recording path.
- OPEN tickets now move to IN_PROGRESS after a Quick Reply is delivered.
- Docker runtime image now includes the Quick Replies configuration.
- Expanded README documentation for Quick Replies, testing, Docker persistence, and security.
- Hardened `.gitignore` for runtime databases, SQLite sidecars, secrets, logs, and generated files.

### Fixed

- Fixed Docker/container startup failure caused by a missing `config/quick-replies.json` file.
- Prevented `/setlogs` from assigning a ticket topic as Support Logs.
- Safely recover legacy Support Logs overrides that point to ticket topics.
- Prevented archive routing from sending transcripts into the ticket topic being archived.
- Prevented duplicate `answerCallbackQuery` attempts in the Quick Replies callback acknowledgement flow.
- Made npm test discovery compatible with Windows.

### Security

- Documented the trusted `STAFF_CHAT_ID` security model.
- Prevented accidental assignment of ticket topics as Support Logs.

## [1.0.1]

### Added

- Telegram forum-topic workflow with one topic per support ticket.
- Support Logs transcript archiving and ticket closure summaries.
- Staff and user help commands, plus staff onboarding.
- User ban and unban tools for ticket access control.

### Fixed

- Improved ticket lifecycle and staff-chat recovery when the configured staff group changes.
- Improved Support Logs topic recovery and ticket archive handling.
