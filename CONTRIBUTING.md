# Contributing

Contributions are welcome when they are focused, reproducible, and consistent with the repository's existing product and operational boundaries. Review the repository license before contributing.

## Before opening a change

- Use a GitHub issue for substantial feature proposals or behavior changes so scope can be agreed first.
- Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues or pull requests.
- Never include bot tokens, `.env` contents, databases, backups, ticket exports, transcripts, or private Telegram data in commits, issues, logs, or screenshots.

## Local setup

```bash
git clone https://github.com/mikhail494/telegram-ticket-system.git
cd telegram-ticket-system
npm ci
cp .env.example .env
```

Node.js 24 LTS is required.

## Required validation

Run the same core checks used by CI before opening a pull request:

```bash
npm run security:audit
npm run format:check
npm run lint
npm exec tsc -- -p tsconfig.json --noEmit
npm run test:typecheck
npm run test:coverage
npm run build
```

Changes that affect the container should also pass:

```bash
docker build -t telegram-ticket-system-local .
```

## Pull request expectations

- Keep each pull request focused on one coherent change.
- Preserve Telegram side-effect ordering, durable recovery semantics, and workspace isolation unless the change explicitly targets them.
- Treat database migrations, persisted state changes, permission changes, and Telegram callback payload changes as compatibility-sensitive work.
- Update tests for changed behavior and retain regression coverage for failure and recovery paths.
- Update documentation and the Unreleased changelog when public behavior or operator workflows change.
- Change `package-lock.json` only when dependency metadata actually changes.
- Do not include production deployment actions or production credentials in a pull request.

The maintainer may ask for a smaller scope when a change mixes product behavior, architecture cleanup, and operational changes.
