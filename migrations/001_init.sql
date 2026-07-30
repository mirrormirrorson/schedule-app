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

CREATE TABLE IF NOT EXISTS mutations (
  id TEXT PRIMARY KEY,
  revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS mutations_created_at_idx
  ON mutations (created_at);
