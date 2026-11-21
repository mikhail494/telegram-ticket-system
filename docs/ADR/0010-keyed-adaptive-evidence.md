# ADR 0010: Keyed Adaptive Evidence

## Context

Unkeyed message-feature digests allow dictionary guessing from a leaked standalone SQLite backup. Historical feedback cannot be regenerated because original moderated text is not stored.

## Decision

Persist `HMAC-SHA256(key, "adaptive-v2\0" + kind + "\0" + legacyDigest)`, where the compatibility digest remains `SHA256(kind + "\0" + normalizedValue)`. Domain separation includes kind and version. The same wrapper transforms old persisted digests and new lookup/write inputs, preserving exact matches and evidence families without recovering text.

The random 32-byte key lives outside SQLite. Migration 28 wraps every feature/observation hash transactionally and stores version/key ID plus a restart-safe cleanup marker. One-time compaction and WAL truncation finish before runtime/backup scheduling so freed cells do not leak the old digests into new backups. Opening migrated data with a missing or mismatched key fails closed. Restore drills receive the installation key, not a generated replacement.

## Alternatives

Direct HMAC over original text cannot migrate historical evidence. A DB-stored key does not protect a DB-only leak. Discarding feedback changes learned behavior.

## Consequences and Limits

Separate key backup is mandatory. Key loss has no silent reset or rotation path. This protects against database-only compromise, not host/key compromise, old backups or forensic recovery of legacy artifacts. It does not encrypt support data.
