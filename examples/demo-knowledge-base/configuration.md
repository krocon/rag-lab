# Configuration reference

Kettlebird reads one TOML file. The location is, in this order:

1. the path given with `--config`,
2. the environment variable `KB_CONFIG`,
3. `~/.config/kettlebird/kettlebird.toml`.

Every key can be overridden with an environment variable: upper-case the key, replace dots with
underscores and add the prefix `KB_`. For example, `server.listen` becomes `KB_SERVER_LISTEN`.

## Server section

```toml
[server]
listen = "127.0.0.1:7420"
dashboard = true
dashboard_token = ""
```

- `listen` – address and port of the HTTP API and dashboard. The default port is **7420**.
- `dashboard` – set to `false` to serve only the HTTP API.
- `dashboard_token` – if set, the dashboard and the API require the header
  `Authorization: Bearer <token>`. Empty means no authentication.

## Storage section

```toml
[storage]
path = "/var/lib/kettlebird/kettlebird.db"
keep_runs = 200
```

- `path` – location of the SQLite state database. Keep it on a local disk; network file systems
  cause "database is locked" errors.
- `keep_runs` – number of runs (with output) kept per job. Older runs are deleted every night at
  03:15 server time.

## Scheduler section

```toml
[scheduler]
timezone = "UTC"
max_parallel = 4
jobs_dir = "./jobs"
```

- `timezone` – IANA time zone used for all schedules without their own `timezone`. Default `UTC`.
- `max_parallel` – maximum number of job runs at the same time across all jobs. Default 4. Runs
  above the limit wait in the queue with status `queued`.
- `jobs_dir` – directory with the job files. Kettlebird reloads it when a file changes.

## Notify section

```toml
[notify]
webhook_url = "https://hooks.example.invalid/kettlebird"
on = ["failure", "parked"]
secret_env = "KB_WEBHOOK_SECRET"
```

- `on` – events that trigger a notification: `failure`, `parked`, `success`, `recovered`.
- `secret_env` – name of the environment variable that holds the HMAC secret. The secret itself is
  never written into the configuration file.
