# ADR 0003: Unknown Delivery Is a First-Class State

## Status

Accepted.

## Context

Telegram operations can be interrupted after a remote side effect may have occurred. Treating an ambiguous failure as an ordinary retry can duplicate user replies or staff actions.

## Decision

Persist `UNKNOWN_DELIVERY` for ambiguous outcomes and require deliberate reconciliation rather than automatic user-facing retry. Staff-only work uses separately persisted recovery state where safe.

## Consequences

Some work requires operator review instead of aggressive automatic retry. The tradeoff is intentional: duplicate support communication is more harmful than conservative recovery.
