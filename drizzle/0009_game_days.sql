CREATE TABLE `game_days` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'single' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`title` text,
	`state` text DEFAULT 'PROPOSED' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
-- Hand-corrected: drizzle-kit drops ON DELETE on an added FK column, which
-- would leave a poll_dates row pointing at a game day that no longer exists.
-- See docs/GOTCHAS.md. The test that deletes a game day is what catches it.
ALTER TABLE `poll_dates` ADD `game_day_id` text REFERENCES game_days(id) ON DELETE SET NULL;