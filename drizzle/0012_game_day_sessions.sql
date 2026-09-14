ALTER TABLE `attendance` ADD `tables_played` text;--> statement-breakpoint
-- Hand-corrected: drizzle-kit drops ON DELETE on an added FK column (GOTCHAS.md).
-- CASCADE, because a session of a game day is not a thing that outlives the day —
-- unlike a campaign's sessions, a one-off has no other reason to exist.
ALTER TABLE `sessions` ADD `game_day_id` text REFERENCES game_days(id) ON DELETE CASCADE;