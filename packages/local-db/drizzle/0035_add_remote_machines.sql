CREATE TABLE `remote_machines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`username` text NOT NULL,
	`identity_file` text,
	`projects_dir` text DEFAULT '~/projects' NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `remote_machines_host_idx` ON `remote_machines` (`host`);--> statement-breakpoint
ALTER TABLE `projects` ADD `remote_machine_id` text REFERENCES remote_machines(id);--> statement-breakpoint
ALTER TABLE `settings` ADD `default_remote_machine_id` text;