## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass
- [ ] Tests pass on a machine with **no Zoho credentials** (this is the default)
- [ ] No new runtime dependency — or the PR explains why the standard library cannot do it
- [ ] No `postinstall` / `preinstall` script added
- [ ] Log redaction is not weakened; no credentials or message bodies can reach logs
- [ ] Remote IDs are still handled as strings (no `Number(id)`, no magnitude comparison)

### If this touches the CLI surface

- [ ] `--json` still emits exactly one JSON document on stdout
- [ ] Failure paths map to a specific exit code, not the catch-all `1`
- [ ] Contract tests cover both success and argument-error paths

### If this touches search or indexing

- [ ] Index writes and query construction both go through `normalizeForIndex`
- [ ] Chinese two-character terms still match (there is a test for this)
- [ ] `NORMALIZER_VERSION` bumped and reindex forced, if normalization behaviour changed

### If this touches the database

- [ ] New migration is numbered consecutively and runs in a transaction
- [ ] Migration is idempotent when re-run
- [ ] New query paths have supporting indexes
