# ADR 0010: Keyed Adaptive Evidence

## Context

Unkeyed message-feature digests allow dictionary guessing from a leaked standalone SQLite backup. Historical feedback cannot be regenerated because original moderated text is not stored.

## Decision

Persist `HMAC-SHA256(key, "adaptive-v2\0" + kind + "\0" + legacyDigest)`, where the compatibility digest remains `SHA256(kind + "\0" + normalizedValue)`. Domain separation includes kind and version. The same wrapper transforms old persisted digests and new lookup/write inputs, preserving exact matches and evidence families without recovering text.

The random 32-byte key lives outside SQLite. Migration 28 wraps every feature/observation hash transactionally and stores version/key ID plus a restart-safe cleanup marker. One-time compaction and WAL truncation finish before runtime/backup scheduling so freed cells do not leak the old digests into new backups. Opening migrated data with a missing or mismatched key fails closed. Restore drills receive the installation key, not a generated replacement.

## Alternatives

Direct HMAC over original text cannot migrate historical evidence. A DB-stored key does not protect a DB-only leak. Discarding feedback changes learned behavior.

## Consequences and Limits

Separate key backup is mandatory: losing it blocks the entire SupportDatabase, not only adaptive moderation. Key loss has no silent reset or rotation path. The explicit interactive `adaptive:recover` command requires stopped/exclusive SQLite ownership and irreversibly clears only adaptive features, observations, OWNER learning feedback and maintenance counters. A private journal/candidate key makes reset and new-key publication resumable; ordinary startup never chooses this path. Business/delivery and sanction history are preserved, and no old backup is restored. See the operations procedure before use.

Trusted parent symlinks/junctions are canonicalized and ownership/permissions checked; the final key remains a private, non-symlink, single-link file. This protects against database-only compromise, not host/key compromise, old backups or forensic recovery of legacy artifacts. It does not encrypt support data.
