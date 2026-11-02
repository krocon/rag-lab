# Retries, timeouts and parked jobs

## When is a run a failure?

A run fails when the command exits with a non-zero exit code, when an HTTP call returns a status
that is not listed in `expect_status`, or when the run exceeds its `timeout`. A run that hits the
timeout is first sent `SIGTERM`; if it is still alive 30 seconds later, Kettlebird sends `SIGKILL`.

## Retry policy

`max_attempts` is the total number of attempts for one scheduled run, including the first one.
The default is 3, so a failing run is retried twice. Set `max_attempts = 1` to disable retries.

Between attempts Kettlebird waits with exponential backoff:

- the first retry waits **30 seconds**,
- every further retry waits twice as long as the previous one,
- the wait never exceeds **10 minutes**,
- a random jitter of ±10 % is added so that many jobs do not retry at the same moment.

You can change the base and the cap per job with `backoff_base = "1m"` and `backoff_cap = "30m"`.

## Parked jobs

When a job fails all attempts of **three scheduled runs in a row**, Kettlebird parks it: the job
keeps its configuration but is no longer scheduled, and its status on the dashboard turns to
`parked`. A `parked` notification is sent if the notify section lists that event.

To resume a parked job after fixing the cause:

```bash
kettlebird jobs unpark nightly-backup
```

`unpark` resets the failure counter. Use `kettlebird jobs run nightly-backup --now` first if you
want to check the fix before the next scheduled time.

## Exit code conventions

Commands can ask Kettlebird not to retry by exiting with code **75**. The run is then recorded as
`failed (no retry)`, which is useful when a retry cannot help, for example when an input file is
missing.
