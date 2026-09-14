CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`min_players` integer,
	`max_players` integer,
	`default_duration_minutes` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "games_players_ck" CHECK("games"."min_players" IS NULL OR "games"."max_players" IS NULL
       OR "games"."min_players" <= "games"."max_players")
);
--> statement-breakpoint
-- `ON DELETE SET NULL` is hand-restored: drizzle-kit drops the referential
-- action when it adds a foreign key column. See docs/GOTCHAS.md.
ALTER TABLE `campaigns` ADD `game_id` text REFERENCES games(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `recurrence_anchor` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `interval_weeks` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `quorum` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `capacity` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `max_sessions` integer;--> statement-breakpoint
ALTER TABLE `campaigns` ADD `first_session_number` integer DEFAULT 1 NOT NULL;