# Security Policy

## Supported versions

RAGLab is in early development (0.x). Only the latest state of the `main` branch receives fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability
reporting for this repository ("Security" tab → "Report a vulnerability"). If that is not
available, contact the maintainer via the e-mail address on their GitHub profile.

Include a description, steps to reproduce, affected version/commit and potential impact. You can
expect an initial response within 7 days.

## Security model and known limitations

- RAGLab is built for **local, single-user use**. There is no authentication or authorization yet.
  Do not expose the API, web app or database to untrusted networks. By default all ports bind to
  `127.0.0.1`.
- **Imported documents are untrusted.** Their content is passed to language models as clearly
  delimited data, and the system prompt instructs the model to ignore instructions inside sources.
  This reduces but **does not eliminate prompt-injection risk**: a crafted document can still
  influence answers. Always verify answers against the cited sources.
- Language model output is untrusted and rendered without executing HTML or scripts.
- Secrets are configured via environment variables only; `.env` is git-ignored. The example
  credentials in `.env.example` are for local development and must be changed for any other use.
