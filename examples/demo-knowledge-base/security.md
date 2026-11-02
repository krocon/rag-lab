# Security notes

## Network exposure

By default the daemon listens on `127.0.0.1:7420` and the dashboard has **no authentication**.
Do not change `listen` to a public address without either setting `server.dashboard_token` or
putting an authenticating reverse proxy in front of it. Anyone who can reach the API can start
jobs with `jobs run --now`.

## Secrets

- Keep secrets out of job files and out of `kettlebird.toml`; both are shown on the dashboard.
- Load secrets with `env_file` per job. The file should be owned by the `kettlebird` user and have
  mode `0600`. Kettlebird refuses to read an `env_file` that is readable by other users.
- The webhook secret is read from the variable named in `notify.secret_env`.

## Webhook signatures

Every webhook request carries the header `X-Kettlebird-Signature`: an HMAC-SHA256 of the raw
request body with the webhook secret, hex-encoded and prefixed with `sha256=`. Receivers should
compare it in constant time and reject requests older than five minutes using the
`X-Kettlebird-Timestamp` header.

## Running commands

Jobs run with the permissions of the daemon's user. Run Kettlebird as a dedicated, unprivileged
user and never as root. The container image already does this.

## Reporting vulnerabilities

The fictional Kettlebird project asks reporters to use a private security advisory instead of a
public issue.
