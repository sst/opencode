CREATE TABLE artifact (
  channel TEXT NOT NULL,
  name TEXT NOT NULL,
  distribution TEXT NOT NULL,
  version TEXT NOT NULL,
  metadata TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  time_updated INTEGER NOT NULL,
  PRIMARY KEY (channel, name, distribution, version)
) WITHOUT ROWID;

CREATE UNIQUE INDEX artifact_active
ON artifact (channel, name, distribution)
WHERE active = 1;
