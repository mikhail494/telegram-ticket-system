# ADR 0009: Node 24 Runtime

## Context

Native SQLite bindings, CLI behavior, tests and container builds need one supported runtime major.

## Decision

Node 24 is the minimum and currently only supported major (`>=24 <25`). CI and the pinned Docker base use Node 24; PM2 must retain an explicit compatible interpreter and shutdown grace period.

## Alternatives

Supporting older majors increases native-binding/test combinations. Accepting every future major without validation overstates compatibility.

## Consequences and Limits

Operators must install Node 24 before upgrades. A newer major requires explicit validation and a separate engine-policy change; this decision does not change PM2 production configuration.
