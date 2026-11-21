# ADR 0011: Operational Metrics Access

## Context

Docker wildcard binding is not host-port publication, but a later publication could expose anonymous operational metrics.

## Decision

Anonymous metrics remain available for numeric loopback binding only. Other bindings require explicit bearer authorization through runtime configuration; a configured token is always required. Health/readiness remain token-free. Authorization uses the configured listener boundary, never Host/forwarded-header claims. Secrets are not baked into images or stored in SQLite.

## Alternatives

Trusting deployment ACLs alone leaves unsafe defaults. Requiring auth for existing native loopback scrapes breaks established operation. Another exporter adds unnecessary infrastructure.

## Consequences and Limits

Docker healthchecks continue working without publishing ports. Remote scraping needs TLS/private networking as well as authorization. Health/readiness still reveal aggregate availability and should remain private.
