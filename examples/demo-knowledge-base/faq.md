# Frequently asked questions

## Can I run two Kettlebird daemons for high availability?

No. Kettlebird is designed for a single machine. Two daemons with the same database file corrupt
the run history, and two daemons with separate databases run every job twice. Use your platform's
restart mechanism (for example a service manager) to restart a crashed daemon instead.

## Does Kettlebird catch up on runs missed while it was stopped?

Only for `daily at` and `weekdays at` schedules, and only for the most recent missed run: if the
daemon was down at 02:30 and starts at 06:00, the job runs once at 06:00. `every` and `cron:`
schedules do not catch up. Set `catch_up = false` in a job file to disable catching up.

## How long is job output kept?

The output of the last 200 runs per job (`storage.keep_runs`). Output longer than 1 MB per run is
truncated in the middle, keeping the first and the last 512 KB.

## Can a job depend on another job?

No, there are no dependencies between jobs. Chain commands inside one job, or let the first job
start the second one with `kettlebird jobs run <name> --now`.

## Which time zone does a schedule use?

The job's own `timezone` key if present, otherwise `scheduler.timezone`, which defaults to `UTC`.

## Is there an HTTP API?

Yes. The daemon serves a JSON API under `/api/v1` on the same port as the dashboard. The
command-line client uses this API, so everything the client can do is also available over HTTP.

## Under which license is Kettlebird released?

The MIT License.
