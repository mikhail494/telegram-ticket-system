# ADR 0003: Unknown Delivery Is a First-Class State

## Status

Accepted.

## Context

Telegram operations can be interrupted after a remote side effect may have occurred. Treating an ambiguous failure as an ordinary retry can duplicate user replies or staff actions.

## Decision

Persist `UNKNOWN_DELIVERY` for ambiguous outcomes and require deliberate reconciliation rather than automatic user-facing retry. This applies to Ticket Batch, interactive staff replies, and each Support Logs archive delivery stage. StaffChatDeliveryCoordinator is staff-only infrastructure: non-idempotent staff sends are replayed only after a confirmed retryable Bot API rejection, while replay-safe state mutations such as edits may use their own retry policy. Customer interactive delivery remains governed by its durable intent state machine.

OWNER and ADMIN operators may record external proof that an unknown operation was delivered, including the Telegram message ID required to finish local transcript or archive state, or record that it was not delivered with an operator note. The first terminal reconciliation wins and is stored in an append-only audit trail. Reconciliation changes durable local truth only; it never invokes or retries the original Telegram send. Any deliberate later delivery must be a new operation with a new identity.

## Consequences

Some work requires operator review instead of aggressive automatic retry. The tradeoff is intentional: duplicate support communication is more harmful than conservative recovery. Operators must verify Telegram directly; the application cannot infer the outcome from an ambiguous transport failure.
