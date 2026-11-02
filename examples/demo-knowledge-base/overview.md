# Kettlebird overview

> Kettlebird is a **fictional** open-source project. It was invented for the RAGLab demo dataset;
> any resemblance to real software is unintended.

Kettlebird is a small, self-hosted job scheduler for teams that have outgrown a crontab but do not
want to operate a distributed workflow engine. It ships as a single binary called `kettlebird`,
keeps its state in one SQLite file and offers a read-only web dashboard.

## What Kettlebird does

- Runs shell commands and HTTP calls on a schedule ("every 15m", "daily at 02:30", cron syntax).
- Retries failed runs with exponential backoff and parks jobs that keep failing.
- Prevents overlapping runs of the same job unless you allow them.
- Sends webhook notifications when a job fails or is parked.
- Keeps the output of the last 200 runs per job for inspection.

## What Kettlebird does not do

- **No clustering.** Kettlebird runs on exactly one machine. Two daemons pointing at the same
  database file are not supported and will corrupt the run history.
- **No workflow graphs.** A job cannot depend on another job. Chain commands inside one job, or
  trigger a second job through the HTTP API at the end of the first one.
- **No native Windows support.** Use the Linux build inside WSL.

## Components

| Component      | Purpose                                                           |
| -------------- | ----------------------------------------------------------------- |
| `kettlebird`   | The binary: daemon (`kettlebird serve`) and command-line client   |
| Job files      | One TOML file per job in the `jobs/` directory                    |
| State database | SQLite file `kettlebird.db` with schedules, runs and output       |
| Dashboard      | Read-only web UI under `/dash`, served by the daemon on port 7420 |

## Project facts

The current stable release is **2.4.0**. Kettlebird is released under the MIT License. Releases
follow semantic versioning; the 2.x series keeps the job file format stable.
