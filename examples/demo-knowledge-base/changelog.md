# Kettlebird changelog

## 2.4.0

- Added the `weekdays at <hh:mm>` schedule form.
- Added `kettlebird doctor` with exit codes 0–3.
- The container image now runs as user `kettlebird` (UID 10001) instead of root.

## 2.3.0

- **Changed:** the default retry backoff is now exponential (30 seconds, doubling, capped at 10
  minutes) instead of a fixed 60 seconds between attempts.
- Added exit code 75 to skip retries for a run.
- Added the `recovered` notification event.

## 2.2.1

- **Fixed:** `daily at` jobs could run twice when daylight saving time ended.
- **Fixed:** `kettlebird logs --tail` printed one line too many.

## 2.2.0

- Added `overlap = "queue"`.
- Added `dashboard_token` for a simple bearer-token protection of dashboard and API.

## 2.0.0

Breaking changes – read the upgrade guide before updating from 1.x:

- The configuration format changed from YAML to TOML.
- The job key `retries` was renamed to `max_attempts` and now counts the first attempt as well
  (`retries = 2` in 1.x equals `max_attempts = 3` in 2.x).
- The default port changed from 8420 to 7420.
- Job output is no longer written to log files but stored in the state database.
