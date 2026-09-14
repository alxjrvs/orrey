CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`detail` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`discord_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_target_idx` ON `audit_log` (`target_type`,`target_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `campaign_members` (
	`campaign_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'player' NOT NULL,
	`character_name` text,
	`joined_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`campaign_id`, `user_id`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`discord_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `signups` (
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`user_id` text NOT NULL,
	`state` text DEFAULT 'in' NOT NULL,
	`position` integer,
	`character_name` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`target_type`, `target_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`discord_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "signups_target_ck" CHECK("signups"."target_type" IN ('campaign_forming', 'game_day'))
);
--> statement-breakpoint
CREATE INDEX `signups_target_idx` ON `signups` (`target_type`,`target_id`,`position`);