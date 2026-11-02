# Handling Time Zones in Software

Date and time bugs are among the most common defects in business software. A few rules prevent
most of them.

## Store timestamps in UTC

Store points in time as UTC, for example in a `timestamptz` column in PostgreSQL or as ISO 8601
strings with a `Z` suffix. Convert to the user's local time zone only when displaying. Never store
local times without their offset, because the same wall-clock time can refer to two different
instants.

## Daylight saving time

Daylight saving time makes some local times occur twice and others not at all. When clocks move
forward in spring, the hour between 02:00 and 03:00 does not exist in many European zones; in
autumn it occurs twice. Scheduling a job at 02:30 local time therefore needs an explicit rule for
both cases. Use the IANA time zone database names such as `Europe/Berlin` rather than fixed offsets
like `+01:00`, because the offset changes with daylight saving time.

## Future events

For a meeting next year, store the local time together with the IANA zone rather than a computed
UTC instant, because governments change daylight saving rules with little notice. Recalculate the
UTC instant from the stored local time when the rules change.

## Testing date logic

Inject a clock into code that depends on the current time instead of calling the system clock
directly. Tests can then freeze time, run at the edges of daylight saving transitions and cover
leap days such as 29 February without waiting for the calendar.
