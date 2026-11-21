# ADR 0007: Instance-Owned Runtime State

## Context

Polling, background work, health counters and alerts share a shutdown boundary but tests may compose several independent bots.

## Decision

The process composition root owns BackgroundTaskRegistry, RuntimeHealthRegistry, RuntimeHealthEvaluator and OperationalAlertCoordinator. Detached work is explicitly accepted and drained; cached backlog observations belong to that runtime/workspace, not global mutable state.

## Alternatives

Process-global registries obscure ownership; a second scheduler duplicates lifecycle coordination.

## Consequences and Limits

Counters/alert transitions reset on restart. SQLite remains the durable truth. Rejected shutdown-time work is not launched or retried; normal durable recovery handles it later.
