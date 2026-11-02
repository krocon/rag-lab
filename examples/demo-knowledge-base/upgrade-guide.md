# Upgrading from 1.x to 2.x

Version 2.0.0 changed the configuration format and several defaults. Plan about fifteen minutes
of downtime for the scheduler.

## Before you start

1. Stop the 1.x daemon.
2. Back up the state directory, in particular `kettlebird.db`. Kettlebird 2.x migrates the
   database on its first start, and there is no way back to 1.x afterwards.
3. Write down which jobs are paused – the pause state is kept, but it is good to double-check.

## Convert the configuration

1.x used YAML. Convert it with the 2.x binary:

```bash
kettlebird migrate-config /etc/kettlebird/config.yaml > /etc/kettlebird/kettlebird.toml
```

The command prints warnings on stderr for keys it cannot convert. Review the result.

## Update the job files

- Rename `retries` to `max_attempts` and add one: `retries: 2` becomes `max_attempts = 3`.
- Job files must be TOML as well; `migrate-config` also accepts a single 1.x job file.

## Ports and firewalls

The default port changed from **8420** to **7420**. Either update firewall rules and reverse
proxies, or keep the old port with `listen = "127.0.0.1:8420"`.

## After the upgrade

Start the 2.x daemon, run `kettlebird doctor` and check that it exits with 0 or 1. Then compare
`kettlebird jobs list` with the list of jobs you had before.
