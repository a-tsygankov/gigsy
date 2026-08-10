-- User settings (docs/plan.md §13, Phase 11).
--
-- One JSON blob rather than a column per setting: settings keep
-- arriving, and a blob with a schema and defaults means adding one is a
-- code change, not a migration. Every read goes through parseSettings(),
-- which fills defaults, so a row written before a setting existed stays
-- valid and NULL simply means "all defaults".
ALTER TABLE users ADD COLUMN settings_json TEXT;
