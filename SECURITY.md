# Security Policy

## Supported versions

RAGLab is in early development (0.x). Fixes go into the `main` branch and the next release; only
the latest release (see [CHANGELOG.md](CHANGELOG.md)) and `main` are supported. Release images are
published to the GitHub Container Registry by the release workflow (docs/release.md).

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability
reporting for this repository ("Security" tab → "Report a vulnerability"). If that is not
available, contact the maintainer via the e-mail address on their GitHub profile.

Include a description, steps to reproduce, affected version/commit and potential impact. You can
expect an initial response within 7 days.

## Security model and known limitations

The threat model, all hardening measures, operating recommendations and residual risks are
documented (in German) in [docs/security.md](docs/security.md). In short:

- RAGLab is built for **local, single-user use** and has **no authentication or authorization**.
  By default all ports bind to `127.0.0.1`. **Never expose RAGLab to a network without a reverse
  proxy that enforces authentication**; the API logs a warning when it listens on a non-local
  address without `NETWORK_ACCESS_PROTECTED=true`.
- The API rejects cross-site requests from browsers (CORS allowlist, Origin check for
  state-changing requests, Host allowlist against DNS rebinding), sets security headers, applies
  rate limits and strict request validation. None of this replaces authentication: any local
  process can still call the API.
- **Imported documents are untrusted.** Their content is passed to language models as delimited
  data, delimiter look-alikes are neutralised, the model has no tools, and the system prompt tells
  it to ignore instructions inside sources. This reduces but **does not prevent prompt
  injection**: a crafted document can still influence answers. Always verify answers against the
  cited sources.
- Language model output and document content are rendered as text only (no HTML, no Markdown).
- Secrets are configured via environment variables only; `.env` is git-ignored and credentials are
  redacted from logs. The example credentials in `.env.example` are for local development and
  must be changed for any other use.
