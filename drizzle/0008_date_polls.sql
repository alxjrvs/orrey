CREATE TABLE `date_polls` (
	`id` text PRIMARY KEY NOT NULL,
	`target_session_id` text,
	`campaign_id` text,
	`game_id` text,
	`game_day_kind` text,
	`win_rule` text DEFAULT 'best_available' NOT NULL,
	`win_threshold` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`opened_by` text,
	`closes_at` integer,
	`discord_channel_id` text,
	`discord_message_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`opened_by`) REFERENCES `users`(`discord_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `date_polls_one_open_per_session` ON `date_polls` (`target_session_id`) WHERE status = 'open' AND target_session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `date_polls_campaign_idx` ON `date_polls` (`campaign_id`,`status`);--> statement-breakpoint
CREATE TABLE `poll_dates` (
	`id` text PRIMARY KEY NOT NULL,
	`poll_id` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`outcome` text DEFAULT 'open' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `date_polls`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "poll_dates_order_ck" CHECK(ends_at > starts_at)
);
--> statement-breakpoint
CREATE INDEX `poll_dates_poll_idx` ON `poll_dates` (`poll_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `poll_responses` (
	`poll_date_id` text NOT NULL,
	`user_id` text NOT NULL,
	`available` integer DEFAULT 1 NOT NULL,
	`responded_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`poll_date_id`, `user_id`),
	FOREIGN KEY (`poll_date_id`) REFERENCES `poll_dates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`discord_id`) ON UPDATE no action ON DELETE cascade
);
