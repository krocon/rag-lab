# Writing job files

Every job lives in its own TOML file in the jobs directory (`scheduler.jobs_dir`). The file name
without extension is the job name, so `jobs/nightly-backup.toml` defines the job `nightly-backup`.
Job names may contain lower-case letters, digits and hyphens.

## A complete example

```toml
description = "Dump the orders database and upload it"
schedule = "daily at 02:30"
timezone = "Europe/Vienna"
command = ["/usr/local/bin/backup-orders", "--compress"]
timeout = "45m"
overlap = "skip"
max_attempts = 3
env_file = "/etc/kettlebird/secrets/backup.env"
```

## Schedule syntax

Kettlebird understands four forms:

| Form                 | Example               | Meaning                                       |
| -------------------- | --------------------- | --------------------------------------------- |
| `every <duration>`   | `every 15m`           | Fixed interval, counted from the daemon start |
| `daily at <hh:mm>`   | `daily at 02:30`      | Once a day at the given local time            |
| `weekdays at <time>` | `weekdays at 09:00`   | Monday to Friday (added in 2.4.0)             |
| `cron: <expression>` | `cron: */5 * * * 1-5` | Classic five-field cron expression            |

Durations use the units `s`, `m` and `h`; the shortest interval is `every 10s`.

## Commands and HTTP calls

`command` is an array: the first element is the executable, the rest are arguments. No shell is
involved, so pipes and `&&` do not work – call `sh -c "…"` explicitly if you need them.

Instead of `command`, a job can define an HTTP call:

```toml
[http]
method = "POST"
url = "http://127.0.0.1:8080/internal/reindex"
expect_status = [200, 202]
```

## Overlapping runs

`overlap` decides what happens when a run is due while the previous run of the same job is still
running:

- `skip` (default) – the new run is not started and recorded as `skipped`.
- `queue` – the new run waits until the previous run has finished. At most one run is queued.
- `allow` – runs may overlap.

## Secrets

Never put passwords or tokens into job files – they are shown on the dashboard. Use `env_file`
to load variables from a file readable only by the `kettlebird` user.
