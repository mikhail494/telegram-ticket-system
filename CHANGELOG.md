# Changelog

All notable changes to this project are documented in this file. This project follows the Keep a Changelog format and Semantic Versioning conventions.

## [Unreleased]

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
