# Gotchas

Traps that are still armed, and the rule each one forces. Remove an entry when
the trap is gone.

- **Workers Free allows five cron triggers per account, not per Worker.** Other
  Workers in this account hold most of them, so a deploy with more than one cron
  fails with code 10072 *after* uploading the script — "partially updated".
  Rule: Orrey has exactly one cron (`* * * * *`); `src/cron/scheduled.ts`
  derives everything else from the time.
