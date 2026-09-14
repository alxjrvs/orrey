ALTER TABLE `game_days` ADD `venue` text;--> statement-breakpoint
-- Hand-corrected: drizzle-kit drops ON DELETE on an added FK column (GOTCHAS.md).
-- Without SET NULL, deleting a user under the privacy route would be refused by
-- the foreign key rather than simply forgetting who was hosting.
ALTER TABLE `game_days` ADD `host_user_id` text REFERENCES users(discord_id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `game_days` ADD `capacity` integer;--> statement-breakpoint
-- Hand-corrected for the same reason. A game removed from the library leaves the
-- days that played it standing, without a name for what was played.
ALTER TABLE `game_days` ADD `game_id` text REFERENCES games(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `game_days` ADD `discord_channel_id` text;--> statement-breakpoint
ALTER TABLE `game_days` ADD `discord_message_id` text;--> statement-breakpoint
ALTER TABLE `game_days` ADD `thread_id` text;