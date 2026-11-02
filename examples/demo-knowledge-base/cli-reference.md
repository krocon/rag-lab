# Command-line reference

All commands accept `--config <path>`. The client commands talk to the running daemon over its
HTTP API; set `--server http://host:port` if the daemon does not listen on the default address.

## Daemon

| Command                         | Description                                          |
| ------------------------------- | ---------------------------------------------------- |
| `kettlebird serve`              | Start the daemon in the foreground                   |
| `kettlebird init`               | Write `kettlebird.toml` and an example job           |
| `kettlebird doctor`             | Check configuration, job files, database and clock   |
| `kettlebird version`            | Print the version                                    |
| `kettlebird migrate-config <f>` | Convert a 1.x YAML configuration to TOML (on stdout) |

`kettlebird serve` stops gracefully on `SIGTERM`: it waits up to 60 seconds for running jobs and
then marks the remaining runs as `interrupted`.

## Jobs

| Command                            | Description                                   |
| ---------------------------------- | --------------------------------------------- |
| `kettlebird jobs list`             | All jobs with schedule, status and next run   |
| `kettlebird jobs run <name> --now` | Start a run immediately, outside the schedule |
| `kettlebird jobs pause <name>`     | Stop scheduling a job until it is resumed     |
| `kettlebird jobs resume <name>`    | Resume a paused job                           |
| `kettlebird jobs unpark <name>`    | Resume a parked job and reset its failures    |
| `kettlebird logs <name> --tail 50` | Output of the last run, last 50 lines         |
| `kettlebird export --format json`  | Export all jobs and their last 20 runs        |

## The doctor command

`kettlebird doctor` exits with:

- `0` – everything is fine,
- `1` – warnings (for example a job without `timeout`),
- `2` – errors that prevent jobs from running (invalid job file, unreachable database),
- `3` – the system clock differs by more than 2 seconds from the configured time source.

Run it after every upgrade and in your deployment pipeline before restarting the daemon.
