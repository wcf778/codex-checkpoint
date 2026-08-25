# Security Policy

## Supported version

Security fixes are applied to the latest release and the `main` branch.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/wcf778/context-checkpoint/security/advisories/new).

Do not attach transcripts, checkpoint state, credentials, private paths, or other sensitive data to a public issue. Include only the minimum redacted reproduction needed to validate the report.

## Security boundary

The deterministic hooks read the Codex transcript path supplied by the host, inspect Git status, and write session state under `PLUGIN_DATA` or the user-level Codex data directory, never the target repository. The optional sidecar is disabled by default, receives a minimal environment, and runs through Codex in an ephemeral, read-only sandbox when explicitly enabled.
