CREATE TABLE IF NOT EXISTS app_state (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  data JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS history_entries (
  id TEXT PRIMARY KEY,
  op_id TEXT,
  ts TIMESTAMPTZ NOT NULL,
  user_name TEXT,
  week TEXT,
  group_name TEXT,
  person TEXT,
  action TEXT,
  content TEXT,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS history_entries_ts_idx
  ON history_entries (ts DESC);
CREATE INDEX IF NOT EXISTS history_entries_week_idx
  ON history_entries (week);
CREATE INDEX IF NOT EXISTS history_entries_group_idx
  ON history_entries (group_name);
CREATE INDEX IF NOT EXISTS history_entries_user_idx
  ON history_entries (user_name);
CREATE INDEX IF NOT EXISTS history_entries_op_idx
  ON history_entries (op_id);

CREATE TABLE IF NOT EXISTS app_users (
  name TEXT PRIMARY KEY,
  id TEXT UNIQUE NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS can_score_radar BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS can_manage_radar_fields BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS mutations (
  id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mutations_created_at_idx
  ON mutations (created_at);

CREATE TABLE IF NOT EXISTS dingtalk_bindings (
  person_id TEXT PRIMARY KEY,
  person_name TEXT NOT NULL,
  dingtalk_user_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  mutation_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  person_name TEXT NOT NULL,
  actor_name TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  available_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_mutation_person_idx
  ON notification_outbox (mutation_id, person_id);
CREATE INDEX IF NOT EXISTS notification_outbox_pending_idx
  ON notification_outbox (status, available_at);

CREATE TABLE IF NOT EXISTS group_notification_outbox (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  available_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS group_notification_outbox_pending_idx
  ON group_notification_outbox (status, available_at);
