ALTER TABLE artifact ADD COLUMN time_created INTEGER NOT NULL DEFAULT 0;

UPDATE artifact SET time_created = time_updated WHERE time_created = 0;
