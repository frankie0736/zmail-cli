# Contributing to zmail-cli

Thanks for considering a contribution.

## You do not need a Zoho account

This is the most important thing to know: **the full test suite runs on a clean
machine with no Zoho credentials and no network access.**

```bash
pnpm install
pnpm test        # must be green, always
```

If `pnpm test` fails on a fresh clone, that is a bug in this project, not in
your setup — please open an issue.

Tests that require a live Zoho account are opt-in and skipped by default:

```bash
ZMAIL_LIVE_TEST=1 ZMAIL_LIVE_PROFILE=test pnpm test
```

Never point live tests at a real business mailbox. Use a dedicated test account.

## Setup

Requires Node.js >= 22 and pnpm.

```bash
git clone https://github.com/frankie0736/zmail-cli.git
cd zmail-cli
pnpm install
pnpm dev -- --help          # run from source
```

`pnpm install` builds `better-sqlite3` from a prebuilt binary. If your platform
has no prebuild, you will need a C++ toolchain (Xcode Command Line Tools on
macOS, `build-essential` and `python3` on Linux). `zmail doctor` diagnoses this
specific failure.

Note that pnpm 10 blocks package build scripts by default. This repository
allowlists the ones it needs via `pnpm.onlyBuiltDependencies` in `package.json`,
so you should not need to run `pnpm approve-builds`.

## Before opening a pull request

```bash
pnpm typecheck
pnpm lint
pnpm test
```

For changes that touch packaging, the CLI surface, or the database:

```bash
pnpm build && pnpm smoke     # global install smoke test
```

## Things that will get a PR sent back

These are not style preferences — each one has caused or would cause a real
class of bug.

**Breaking the JSON contract.** In `--json` mode, stdout must contain exactly
one valid JSON document. Progress, warnings and logs go to stderr. Every
foreseeable failure maps to a specific exit code — never the catch-all `1`.
If you add a command, add a contract test for both its success and failure paths,
including what happens when arguments are wrong.

**Bypassing `normalizeForIndex`.** Index writes and query construction must call
the same normalization function. Skipping it on either side makes Chinese search
silently return nothing — no error, just no results. If you change the
function's behaviour, bump `NORMALIZER_VERSION` and add a migration that forces
a reindex.

**Treating remote IDs as numbers.** Zoho mixes quoted and bare numeric IDs, and
some exceed 2^53. All remote IDs are `TEXT` in the database and branded strings
in code. Never `Number(id)`, never compare them by magnitude.

**Logging credentials or message bodies.** Access tokens, refresh tokens, client
secrets, full `Authorization` headers, complete message bodies and unredacted
recipient lists must never reach logs. `src/output/redact.ts` is the last line of
defence, not the first.

**Adding a runtime dependency casually.** This tool asks users to trust it with
their OAuth credentials and their entire mailbox. Every runtime dependency is
supply-chain attack surface. Check whether the standard library can do it first,
and say why it cannot in the PR description.

**Adding an install script.** No `postinstall`, no `preinstall`. All setup work
belongs in `zmail init`.

**Widening write access to Zoho.** The permission model opens in stages
(read-only → local drafts → Zoho drafts → two-phase send). Remote delete is not
on the roadmap. Any PR that expands what the tool can do to a remote mailbox
needs to explain its safety argument.

## Language

Code, comments, commit messages, CLI output and documentation are in **English**.
`README.zh-CN.md` is the exception. The design document under `docs/` is an
internal working document and is not part of the repository.

## Reporting bugs

Use the issue templates. Run `zmail doctor --json` and paste its output — it is
designed to be safe to share publicly (email addresses masked, no credentials).

**Do not paste real email content, real addresses, or tokens into an issue.**

For security vulnerabilities, see [SECURITY.md](SECURITY.md) — do not use public
issues.

## Commit messages

Short imperative subject, then a body explaining *why* when the reason is not
obvious from the diff. Reference the design section when a change implements or
revises one.
