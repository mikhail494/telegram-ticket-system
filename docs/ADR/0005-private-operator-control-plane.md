# ADR 0005: Extract private operator control plane

## Status

Accepted.

## Context

`createBot` composes all Telegram update paths. Private OWNER and ADMIN screens also require one authoritative message, stale-callback protection, picker cleanup, and short-lived editor sessions. Keeping that state beside unrelated ticket and moderation work obscured its ownership.

## Decision

Keep `bot.ts` as the grammY composition and route-registration layer. `PrivateControlPlane` owns private-screen lifecycle, private editor and picker state, and the Support settings and Quick Replies operator UI. It orchestrates existing `InstallationService`, `SupportDatabase`, and Quick Replies services; their domain rules and durable state remain where they are.

## Consequences

Private operator behavior is directly testable without bootstrapping the full ticket pipeline. The control plane intentionally remains grammY-aware and ephemeral session state remains in memory. Further private screens can move incrementally without a generic UI framework or a rewrite.
