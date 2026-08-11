# ADR 0001: SQLite for the Current Deployment

## Status

Accepted.

## Context

The bot runs as one application instance and needs durable tickets, settings, batch state, moderation state, and restart recovery without operating a separate database service.

## Decision

Use `better-sqlite3` with SQLite and WAL mode. Transactions and persistent migration records provide a small operational footprint with durable, idempotent state transitions.

## Consequences

This is well suited to the current single-instance deployment and simple backup model. Horizontal multi-writer scaling would require a different persistence strategy or a more deliberate coordination layer.
