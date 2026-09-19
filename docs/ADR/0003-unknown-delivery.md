# ADR 0003: Unknown Delivery Is a First-Class State

## Status

Accepted.

## Context

Telegram operations can be interrupted after a remote side effect may have occurred. Treating an ambiguous failure as an ordinary retry can duplicate user replies or staff actions.

## Decision

Persist `UNKNOWN_DELIVERY` for ambiguous outcomes and require deliberate reconciliation rather than automatic user-facing retry. This applies to Ticket Batch, interactive staff replies, and each Support Logs archive delivery stage. StaffChatDeliveryCoordinator is staff-only infrastructure: non-idempotent staff sends are replayed only after a confirmed retryable Bot API rejection, while replay-safe state mutations such as edits may use their own retry policy. Customer interactive delivery remains governed by its durable intent state machine.

## Consequences

Some work requires operator review instead of aggressive automatic retry. The tradeoff is intentional: duplicate support communication is more harmful than conservative recovery.
