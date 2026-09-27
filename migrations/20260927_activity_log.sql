-- Activity log (who did what, when). Kept 1 year (purged by the app). Idempotent.
CREATE TABLE IF NOT EXISTS activity_log (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id    INT,
  actor_name  TEXT,
  category    TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  summary     TEXT NOT NULL,
  details     JSONB,
  ip          TEXT
);

CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS activity_log_actor_idx ON activity_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_category_idx ON activity_log (category, created_at DESC);
