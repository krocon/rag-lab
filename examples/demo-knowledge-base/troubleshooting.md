# Troubleshooting

## "address already in use" on startup

Another process listens on port 7420. Either stop it or move Kettlebird to another port, for
example `listen = "127.0.0.1:7421"` in the `[server]` section or `KB_SERVER_LISTEN=127.0.0.1:7421`.

## "database is locked"

The state database is on a network file system, or a second daemon uses the same file. Move
`storage.path` to a local disk and make sure only one `kettlebird serve` process runs. Kettlebird
does not support clustering.

## A job ran twice when the clocks changed

Versions before 2.2.1 could start a `daily at` job twice in the night when daylight saving time
ended, because the local time 02:30 existed twice. Upgrade to 2.2.1 or later. If you cannot
upgrade, schedule the job outside the hour between 02:00 and 03:00 or set `timezone = "UTC"` for
that job.

## Runs stay in "queued"

All slots are in use: more runs are due than `scheduler.max_parallel` allows (default 4). Check
for long-running jobs with `kettlebird jobs list` and give them a `timeout`, or raise
`max_parallel`.

## A job never starts

1. Run `kettlebird doctor`; exit code 2 points to an invalid job file and names the line.
2. Check that the file name ends in `.toml` and uses only lower-case letters, digits and hyphens.
3. Check whether the job is `paused` or `parked` in `kettlebird jobs list`.

## The dashboard shows "401 Unauthorized"

`server.dashboard_token` is set. Open the dashboard with `?token=<token>` once; the browser keeps
it in a session cookie. API clients send `Authorization: Bearer <token>`.

## Webhook notifications do not arrive

Check that the event is listed in `notify.on` and that the environment variable named in
`notify.secret_env` is set for the daemon. `kettlebird doctor` warns if the variable is missing.
