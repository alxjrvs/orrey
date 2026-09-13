PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`discord_channel_id` text,
	`discord_role_id` text,
	`colour` integer,
	`location_type` text DEFAULT 'external' NOT NULL,
	`discord_voice_channel_id` text,
	`state` text DEFAULT 'FORMING' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_campaigns`("id", "name", "kind", "discord_channel_id", "discord_role_id", "colour", "location_type", "discord_voice_channel_id", "state", "created_at", "updated_at") SELECT "id", "name", "kind", "discord_channel_id", "discord_role_id", "colour", "location_type", "discord_voice_channel_id", "state", "created_at", "updated_at" FROM `campaigns`;--> statement-breakpoint
DROP TABLE `campaigns`;--> statement-breakpoint
ALTER TABLE `__new_campaigns` RENAME TO `campaigns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;