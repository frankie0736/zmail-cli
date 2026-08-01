# Security Policy

`zmail-cli` handles OAuth credentials and mirrors your entire mailbox to local
storage. Security issues here are serious, and we treat them accordingly.

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use [GitHub Private Vulnerability Reporting](https://github.com/frankie0736/zmail-cli/security/advisories/new)
— this creates a private channel visible only to maintainers.

What to expect:

| Stage | Target |
|---|---|
| Acknowledgement | within 72 hours |
| Initial assessment | within 7 days |
| Fix or mitigation plan | within 30 days for high severity |

When reporting, please include the affected version (`zmail --version`), your
platform, reproduction steps, and the impact you believe it has.

**Never include real tokens, passwords, or actual email content in a report.**
If you need to demonstrate an issue with credentials, redact them or describe
their shape instead.

## Supported Versions

While the project is pre-1.0, only the latest published version receives
security fixes. Upgrade before reporting.

## Security Model

Understanding these boundaries helps you judge whether something is a
vulnerability:

### Credentials

- **Access tokens are never written to disk.** They exist only in process memory
  for the lifetime of a single command.
- **Refresh tokens, client ID and client secret** go to the OS keystore
  (macOS Keychain) or, on other platforms, an encrypted file
  (`scrypt` N=2^17 + AES-256-GCM) under `~/.zmail/secrets.enc`.
- The encrypted-file backend is **not equivalent to an OS keystore**. Its
  strength depends entirely on your passphrase. `zmail doctor` always reports
  which backend is active and at what security level.
- Credentials are never written to `~/.zmail/config.json`, `.env` files, logs,
  or the published npm package.

### Known accepted limitations

- On macOS, `security add-generic-password -w <secret>` briefly exposes the
  secret in process arguments, where another local user could observe it via
  `ps`. This is accepted for a single-user personal machine. The `SecretStore`
  interface exists specifically so this backend can be replaced.
- The encrypted-file backend does not protect against an attacker who already
  has both your `secrets.enc` and your passphrase.

### Local data

- `~/.zmail/` is created with mode `0700`, files with `0600`.
- `zmail doctor` detects and `zmail init` repairs permissions that have become
  too permissive (common after restoring from a backup or syncing with rsync).
- The process sets `umask(0o077)` at startup.

### Network and privacy

- **No telemetry. No crash reporting. No usage analytics.** The only network
  destination is Zoho's API, using your own OAuth application.
- Local mail data never leaves your machine.

### Logging

Logs are structured and go to stderr. They must never contain access tokens,
refresh tokens, client secrets, full `Authorization` headers, full message
bodies, or unredacted recipient lists. `zmail doctor --json` output is
specifically designed to be safe to paste into a public issue — email addresses
are masked and no credential material is included.

If you find any of these guarantees violated, that is a security bug worth
reporting.

## Supply Chain

- Published from CI via npm Trusted Publishing (OIDC). No long-lived npm tokens
  exist in the repository or in GitHub Secrets.
- Releases carry [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
  so you can verify the published tarball was built from a specific commit in
  this repository. Verify it yourself with `npm audit signatures`.

  **Exception: `0.1.0` was published manually and has no provenance.** npm can
  only attest to builds that happen on a supported CI runner, and trusted
  publishing has to be configured on a package that already exists — so the
  first release cannot have it. Every version after `0.1.0` is published by CI
  and attested. If provenance matters to you, install `0.1.1` or later.
- **No `postinstall` or `preinstall` scripts.** All initialization happens when
  you first run `zmail init`.
- Runtime dependencies are kept deliberately minimal. Each one is attack surface.
