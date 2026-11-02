# PostgreSQL Backups and Restore

A backup that has never been restored is only a hope. This guide covers the two main backup styles
for PostgreSQL and how to verify them.

## Logical backups with pg_dump

`pg_dump` writes the contents of one database as SQL or in a compressed custom format
(`pg_dump -Fc mydb > mydb.dump`). Logical dumps are portable across major versions and let you
restore single tables with `pg_restore -t`. They are consistent snapshots but slow for very large
databases, and everything written after the dump started is not included. `pg_dumpall` adds roles
and other cluster-wide objects.

## Physical backups and point-in-time recovery

A physical backup copies the data directory, for example with `pg_basebackup`. Combined with
continuous archiving of the write-ahead log (WAL), it allows point-in-time recovery: you restore the
base backup and replay archived WAL segments up to a chosen moment, such as one minute before an
accidental `DROP TABLE`. Configure `archive_mode` and an `archive_command`, or use a tool such as
pgBackRest that manages retention and compression.

## Testing restores

Schedule a restore test, ideally automated: restore the latest backup into a scratch server, run a
few sanity queries and record how long it took. The duration is your realistic recovery time.
Monitor the age of the newest backup and alert when it is older than expected.

## Retention

Keep several generations, for example daily backups for two weeks and monthly ones for a year, and
store at least one copy in another location or account so that a single compromised credential
cannot delete all of them.
