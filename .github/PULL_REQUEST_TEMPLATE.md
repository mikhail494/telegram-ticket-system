## Summary

Describe what changed and why.

## Scope

- [ ] This pull request is focused on one coherent change.
- [ ] User-facing Telegram text or callback behavior is unchanged, or the change is documented below.
- [ ] Database schema or persisted-state behavior is unchanged, or the migration/compatibility impact is documented below.
- [ ] No production deployment or production credentials are included.

## Validation

- [ ] `npm run security:audit`
- [ ] `npm run format:check`
- [ ] `npm run lint`
- [ ] `npm exec tsc -- -p tsconfig.json --noEmit`
- [ ] `npm run test:typecheck`
- [ ] `npm run test:coverage`
- [ ] `npm run build`
- [ ] Docker build/runtime checks, if container behavior changed

## Security and privacy

- [ ] No secrets, private Telegram data, databases, backups, transcripts, or unredacted support exports are included.
- [ ] Security-sensitive behavior is documented and tested where applicable.

## Compatibility notes

List any changes to commands, callbacks, permissions, migrations, recovery semantics, dependencies, or operator workflows. Write `None` when there are none.
