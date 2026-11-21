# ADR 0008: Executable Architecture Fitness

## Context

Large existing modules cannot all be decomposed safely in one release; new coupling must not accumulate unnoticed.

## Decision

CI checks emitted runtime dependencies, cycles, persistence layers, SQLite ownership and physical-line budgets. New modules default to 800 lines. Existing exceptions have decreasing baselines and exactly 25 lines of headroom; shrinking requires lowering the recorded budget. Pull requests compare with the trusted target-branch merge base; protected main pushes compare with the event's previously accepted commit. A later metadata-only budget edit cannot hide an earlier increase.

## Alternatives

Review-only guidance is easy to miss. Automated baseline regeneration hides regressions. A mandatory whole-repository refactor risks behavior changes.

## Consequences and Limits

Full Git history and a valid trusted event/base are required in CI; missing history/base fails closed. Local checks use the merge base with `origin/main` (or explicit `ARCHITECTURE_BASE_REF` for local fixtures). The check is read-only, counts LF/CRLF consistently and does not replace behavioral review. No cycles are grandfathered.
