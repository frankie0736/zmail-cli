# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While on `0.x`, a minor bump may contain breaking changes; those are always
called out explicitly.

## [0.1.1] — 2026-08-01

First release published by CI, and therefore the first with npm provenance —
verify it with `npm audit signatures`.

### Fixed

- CI had never executed a single test. `pnpm/action-setup` resolves its version
  from `packageManager` in package.json, which was missing, so every run since
  the repository was created failed at the first step.
- Export-path tests asserted POSIX separators and failed on Windows. The code
  was correct; only the assertions were platform-bound.
- The global-install smoke test parsed `npm pack --json` assuming npm 10's
  array shape, while CI installs npm@latest. It also could not spawn `npm.cmd`
  on Windows, which Node refuses without a shell since CVE-2024-27980.
- `bin` path normalized so npm stops silently rewriting the manifest on publish.

### Changed

- The Keychain service name no longer contains the maintainer's personal
  identifier. It is now `zmail-cli`. **Credentials stored by 0.1.0 will not be
  found** — re-run `zmail auth setup` and `zmail auth login`, or set
  `keychainService` back in config.json.
- The release workflow verifies the tag matches package.json before building,
  rather than after the full test and smoke run.

## [0.1.0] — 2026-08-01

### Added

- Read-only mirror of a Zoho mailbox in local SQLite, with offline full-text
  search over subject, sender, recipients and body.
- Chinese full-text search that works for two-character business terms. FTS5's
  default tokenizer treats a run of Han characters as a single token, which
  makes 询价, 报价, 样品 and 交期 unfindable; the index and every query pass
  through the same CJK-aware normalization.
- OAuth 2.0 loopback authorization bound to `127.0.0.1`, with constant-time
  state validation. Access tokens live only in memory.
- Credential storage in the macOS Keychain, or an encrypted file
  (scrypt + AES-256-GCM) on platforms without an OS keystore. `zmail doctor`
  reports which backend is active and at what security level.
- Full and quick sync, resumable from a checkpoint, with rate-limit backoff
  that honours `Retry-After`.
- Attachment metadata sync with on-demand, content-addressed download.
  Identical attachments across messages share one blob.
- Export to `eml`, `mbox` and `jsonl`.
- `zmail data stats` reporting disk usage per component, plus `verify`,
  `backup`, `prune`, `reset` and `purge`.
- Agent skill (`skills/zoho-mail/`) and JSON Schemas (`schemas/`) shipped in
  the package.
- Shell completion for bash, zsh and fish.

### Security

- Attachment and export filenames are sanitized against path traversal,
  Windows reserved device names, control characters and over-length names,
  with a final containment check on the resolved path.
- Downloads verify byte count against the server's declared size; a truncated
  transfer fails rather than being recorded as a successful download.
- Logs and `zmail doctor` output are redacted so they can be shared publicly.

### Notes

`0.1.0` was published manually and therefore carries no npm provenance; see
SECURITY.md. Subsequent releases are published by CI and attested.

[0.1.1]: https://github.com/frankie0736/zmail-cli/releases/tag/v0.1.1
[0.1.0]: https://github.com/frankie0736/zmail-cli/releases/tag/v0.1.0
