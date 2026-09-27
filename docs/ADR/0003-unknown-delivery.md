# ADR 0003: Unknown Delivery Is a First-Class State

## Status

Accepted.

## Context

Telegram operations can be interrupted after a remote side effect may have occurred. Treating an ambiguous failure as an ordinary retry can duplicate user replies or staff actions.

## Decision

Persist `UNKNOWN_DELIVERY` for ambiguous outcomes and require deliberate reconciliation rather than automatic user-facing retry. This applies to Ticket Batch, interactive staff replies, each Support Logs archive delivery stage, and durable customer-to-staff routing stages such as forum-topic creation and staff-topic sends. StaffChatDeliveryCoordinator is staff-only infrastructure: non-idempotent staff sends are replayed only after a confirmed retryable Bot API rejection, while replay-safe state mutations such as edits may use their own retry policy. Customer interactive delivery remains governed by its durable intent state machine.

OWNER and ADMIN operators may record external proof that an unknown operation was delivered, including the Telegram message ID required to finish local transcript or archive state, or record that it was not delivered with an operator note. The first terminal reconciliation wins and is stored in an append-only audit trail. Reconciliation changes durable local truth only; it never invokes or retries the original Telegram send. Any deliberate later delivery must be a new operation with a new identity.

Inbound routing uses source chat/message, stage, and attempt generation as its logical identity. `COPY_ORIGINAL` is required delivery, not decoration: media and untruncated long text remain unresolved until copied or explicitly settled. Delivery Review accepts the actual topic ID for `CREATE_TOPIC` and the message ID for send/copy stages, then continues only subsequent stages. Confirmed non-delivery waits for a separate audited new-attempt action; the ambiguous identity is never reset for replay. Migration 27 owns this inbound state and append-only audit without changing migration 26.

Ticket closure atomically cancels eligible unsent stages while preserving received content. It cannot cancel an in-flight/unknown attempt or reopen a closed ticket through status CAS. A required copy after proven formatted delivery still blocks archive until resolved, including after closure. A confirmed missing-topic rejection permits a new safe attempt on a replacement topic for an active ticket. On a closed ticket, a confirmed Telegram copy rejection permits cancellation and archive of the retained content instead of another copy attempt; it does not claim delivery. Ambiguous copies remain unresolved. Terminal routing outcomes after closure resume the existing archive path when no unresolved inbound work remains. Archive checks positive terminal states rather than assuming every non-pending state is complete.

## Consequences

Some work requires operator review instead of aggressive automatic retry. The tradeoff is intentional: duplicate support communication is more harmful than conservative recovery. Operators must verify Telegram directly; the application cannot infer the outcome from an ambiguous transport failure.
