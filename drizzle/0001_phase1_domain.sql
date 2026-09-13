CREATE TABLE `attendance` (
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`intent` text,
	`attended` integer,
	`attended_source` text,
	`note` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`session_id`, `user_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`discord_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `calendar_links` (
	`session_id` text PRIMARY KEY NOT NULL,
	`gcal_event_id` text NOT NULL,
	`fingerprint` text,
	`synced_at` integer,
	`last_error` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_links_gcal_event_id_unique` ON `calendar_links` (`gcal_event_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`discord_channel_id` text,
	`discord_role_id` text,
	`colour` integer,
	`location_type` text DEFAULT 'external' NOT NULL,
	`discord_voice_channel_id` text,
	`state` text DEFAULT 'RUNNING' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`campaign_id` text,
	`number` integer,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`location` text,
	`state` text DEFAULT 'SCHEDULED' NOT NULL,
	`discord_event_id` text,
	`discord_message_id` text,
	`thread_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_parent_ck" CHECK(("sessions"."kind" = 'campaign_session' AND "sessions"."campaign_id" IS NOT NULL)
       OR ("sessions"."kind" = 'one_off' AND "sessions"."campaign_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `sessions_starts_idx` ON `sessions` (`starts_at`);--> statement-breakpoint
CREATE INDEX `sessions_campaign_idx` ON `sessions` (`campaign_id`,`starts_at`);