# zmail-cli

**A local-first Zoho Mail mirror, search engine and safe-write CLI, built for AI agents.**

> `zmail-cli` is an independent open-source project. It is not affiliated with,
> endorsed by, or sponsored by Zoho Corporation. "Zoho" and "Zoho Mail" are
> trademarks of Zoho Corporation.

[简体中文](README.zh-CN.md)

---

## Why

AI coding agents — Claude Code, Codex, and friends — can run shell commands. What
they cannot do well is read your mailbox. Web interfaces are unscriptable, IMAP
output is unstructured, and every question means another round trip to a remote
API.

`zmail-cli` mirrors your Zoho mailbox into local SQLite with a full-text index,
then exposes it through a CLI that returns stable JSON. Your agent searches
years of correspondence offline, in milliseconds, without a single network call.

You keep using Zoho WebMail for reading and replying. The two stay consistent
through sync.

## Three promises

**Your mail stays on your machine.** No telemetry, no crash reporting, no usage
analytics. Ever. The only network destination is Zoho's API, through your own
OAuth application.

**Your credentials stay in the OS keystore.** Access tokens live in process
memory and are never written to disk. Refresh tokens go to the macOS Keychain,
or an encrypted file on other platforms. `zmail doctor` tells you exactly which
backend is active and at what security level — it will not pretend an encrypted
file is equivalent to a system keychain.

**Your data is not locked in.** SQLite is an open format, and
`zmail export --format eml|mbox|jsonl` gets everything out whenever you want.

## Status

**Read-only pipeline complete.** Not yet published
to npm — see the release checklist below.

| Phase | Scope | Status |
|---|---|---|
| 0 | Zoho API and OAuth validation | done |
| 1 | Package skeleton, config, credentials, database, CI | done |
| 2 | OAuth implementation | done |
| 3 | Read-only mail sync + FTS5 search | done |
| 4 | Attachments, export, data maintenance | done |
| 5 | Agent skill and first npm release | in progress |
| 6–7 | Local drafts → Zoho drafts → two-phase send | planned |

The read-only pipeline works end to end against a live mailbox. What remains
before publishing is documentation polish and the release workflow.

## Install

```bash
npm install -g zmail-cli    # not yet published
```

Requires Node.js >= 22 on macOS, Linux or Windows.

## Quick start

```bash
zmail init          # create ~/.zmail/ (0700) and the database
zmail auth setup    # store your Zoho OAuth client credentials
zmail auth login    # authorize via loopback OAuth
zmail sync --full   # build the local mirror

zmail search "silicone tubing quotation" --json
zmail thread get <thread-id> --json
```

Everything after `sync` runs offline. Searching a synced mailbox makes no
network call at all.

Setting up a Zoho OAuth application takes about three minutes and is a one-time
step — see **[docs/oauth-setup.md](docs/oauth-setup.md)**. API quota is counted
per client, so having your own is an advantage rather than a chore.

## For agents

The package ships an agent skill. Point your agent at it:

```bash
zmail skill path          # where SKILL.md and its references live
cp -r "$(zmail skill path --json | jq -r .data.skillDir)" ~/.claude/skills/
```

JSON Schemas for the output envelope and search results are bundled under
`schemas/`, so an agent can validate what it receives.


Every command accepts `--json` and returns a stable envelope:

```json
{ "ok": true, "data": {}, "meta": { "profile": "primary", "source": "local" } }
```

```json
{ "ok": false, "error": { "code": "AUTH_REQUIRED", "message": "...", "retryable": false, "details": {} } }
```

Guarantees your agent can rely on:

- In `--json` mode, stdout carries **exactly one** JSON document. Logs, progress
  and warnings go to stderr — including argument errors and help text.
- Every foreseeable failure maps to a specific exit code, never the catch-all `1`.
- Remote IDs are always strings. Zoho mixes quoted and bare numeric IDs and some
  exceed 2^53, so anything else would silently corrupt them.
- Timestamps are ISO 8601 with a timezone offset.
- Removing a field is a breaking change; adding an optional one is not.

Exit codes: `0` ok · `2` usage · `3` not found · `4` not initialized ·
`5` unauthorized · `6` network · `7` Zoho API · `8` rate limited · `9` database ·
`10` sync locked · `11` approval required · `12` insufficient scope ·
`13` incomplete data · `14` credential backend

## Search works in Chinese

FTS5's `unicode61` tokenizer treats a run of Han characters as a **single**
token, so searching 硅胶管 inside 客户询价硅胶管报价单 returns nothing. The
`trigram` tokenizer needs at least three characters, which breaks every
two-character business term — 询价, 报价, 样品, 交期.

`zmail-cli` splits CJK characters at index time and applies the identical
normalization to queries, so both of these work:

```bash
zmail search --query "询价" --json
zmail search --query "silicone tubing" --json
```

The failure mode this avoids is the nastiest kind: no error, just no results.

## Safety model

Write access opens in stages, and each stage is a deliberate decision:

| Version | Capability |
|---|---|
| v0.1 | Read-only: sync, search, read, download attachments |
| v0.2 | Local drafts — cannot be pushed or sent |
| v0.3 | Push drafts to Zoho Drafts for human review in WebMail |
| v0.4 | Two-phase send: `prepare-send` → human approval token → `send` |

Permanently out of scope: remote delete, bulk sending, sending without explicit
human approval, and letting an agent run arbitrary SQL.

## Where your data lives

```
~/.zmail/
├── config.json      non-sensitive settings only, never credentials
├── mail.sqlite3     messages, full-text index, local annotations
├── attachments/     content-addressed by SHA-256, deduplicated
├── secrets.enc      only on platforms without an OS keystore
└── logs/
```

Override with `--data-dir <path>` or `ZMAIL_HOME`.

Uninstalling the npm package never touches `~/.zmail/`. Deleting your data is
always an explicit, confirmed action (`zmail data purge`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: **you do not need a
Zoho account to work on this.** `pnpm test` runs green on a clean machine with
no credentials and no network — if it does not, that is a bug worth reporting.

Security issues go through
[private vulnerability reporting](https://github.com/frankie0736/zmail-cli/security/advisories/new),
never a public issue. See [SECURITY.md](SECURITY.md).

## License

MIT
