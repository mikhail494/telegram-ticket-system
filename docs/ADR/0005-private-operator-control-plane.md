# ADR 0005: Extract private operator control plane

## Status

Accepted.

## Context

`createBot` composes all Telegram update paths. Private OWNER and ADMIN screens also require one authoritative message, stale-callback protection, picker cleanup, and short-lived editor sessions. Keeping that state beside unrelated ticket and moderation work obscured its ownership.

## Decision

Keep `bot.ts` as the grammY composition and route-registration layer. `PrivateControlPlane` owns private-screen lifecycle, stale callback rejection, dashboard navigation, System status, Team, public-chat management, moderation settings, Support settings, Quick Replies, and their short-lived editor and picker state. It exposes one callback dispatcher and one private-input dispatcher. It orchestrates existing `InstallationService`, `SupportDatabase`, and Quick Replies services; their domain rules and durable state remain where they are.

## Consequences

Private operator behavior is directly testable without bootstrapping the full ticket pipeline. The control plane intentionally remains grammY-aware and ephemeral session state remains in memory. `bot.ts` retains setup/workspace validation, Support Logs initialization, owner-transfer security, and Batch business callbacks because those flows cross service and Telegram delivery boundaries. Further extraction remains incremental rather than a generic UI framework or a rewrite.
