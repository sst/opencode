CREATE TABLE channel_rollout (
  channel TEXT PRIMARY KEY,
  duration_hours REAL NOT NULL CHECK (duration_hours >= 0)
);
