CREATE TABLE `publications` (
	`id` text PRIMARY KEY NOT NULL,
	`surface` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`remote_id` text,
	`channel_id` text,
	`state` text DEFAULT 'claimed' NOT NULL,
	`claimed_at` integer DEFAULT (unixepoch()) NOT NULL,
	`published_at` integer,
	`retracted_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `publications_target_idx` ON `publications` (`target_id`,`state`);