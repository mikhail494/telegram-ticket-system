# ADR 0006: Split persistence domains behind SupportDatabase facade

## Status

Accepted.

## Context

`SupportDatabase` owned the SQLite connection and also contained persistence for tickets, Batch, installation, moderation, and Quick Replies. The public API is widely used across the application, so replacing it with a broad nested-repository migration would make a structural refactor unnecessarily risky.

## Decision

Keep `SupportDatabase` as the sole connection, migration, backup, and lifecycle owner. Move SQL implementations into concrete domain repositories that share that connection. Retain each existing public `SupportDatabase` method as an explicit delegating compatibility facade and re-export existing record types from `db.ts`.

## Consequences

Persistence responsibilities are smaller and easier to audit without changing callers, SQL semantics, or transaction ownership. The facade remains intentionally broad for now; a future change may introduce narrower application-facing interfaces only where a concrete consumer needs one.
