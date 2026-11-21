# ADR 0008: Executable Architecture Fitness

## Context

Large existing modules cannot all be decomposed safely in one release; new coupling must not accumulate unnoticed.

## Decision

CI checks emitted runtime dependencies, cycles, persistence layers, SQLite ownership and physical-line budgets. New modules default to 800 lines. Existing exceptions have decreasing baselines and exactly 25 lines of headroom; shrinking requires lowering the recorded budget. Version history prevents raising an already-reduced exception.

## Alternatives

Review-only guidance is easy to miss. Automated baseline regeneration hides regressions. A mandatory whole-repository refactor risks behavior changes.

## Consequences and Limits

Full Git history is required in CI. The check is read-only, counts LF/CRLF consistently and does not replace behavioral review. No cycles are grandfathered.
