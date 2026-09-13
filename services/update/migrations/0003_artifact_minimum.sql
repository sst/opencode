ALTER TABLE artifact ADD COLUMN minimum INTEGER NOT NULL DEFAULT 0 CHECK (minimum IN (0, 1));

CREATE UNIQUE INDEX artifact_minimum
ON artifact (channel, name, distribution)
WHERE minimum = 1;
