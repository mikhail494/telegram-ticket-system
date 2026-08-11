# ADR 0002: Telegram Long Polling

## Status

Accepted.

## Context

The current service is deployed as one long-running bot process and does not require public webhook ingress.

## Decision

Use grammY long polling after startup recovery completes.

## Consequences

Long polling keeps deployment and local operation simple and avoids webhook routing, certificates, and public ingress. A webhook deployment could reduce idle polling overhead and better fit horizontally scaled hosting, but would add operational components that are not needed today.
