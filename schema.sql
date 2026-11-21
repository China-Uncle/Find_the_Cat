PRAGMA foreign_keys = ON;

-- SQLite timestamps are integer milliseconds, not client-provided times.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  auth_provider TEXT NOT NULL CHECK(auth_provider IN ('github','guest','wechat','password')),
  open_id TEXT NOT NULL,
  username TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  current_level INTEGER NOT NULL DEFAULT 1 CHECK(current_level >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(auth_provider, open_id)
);
CREATE TABLE IF NOT EXISTS levels (
  id INTEGER PRIMARY KEY CHECK(id >= 1),
  size INTEGER NOT NULL CHECK(size BETWEEN 4 AND 11),
  region_map TEXT NOT NULL CHECK(json_valid(region_map)),
  solution TEXT NOT NULL CHECK(json_valid(solution)),
  map_hash TEXT NOT NULL,
  seed INTEGER NOT NULL,
  search_nodes INTEGER NOT NULL,
  generation_attempts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(size, map_hash)
);
CREATE INDEX IF NOT EXISTS idx_levels_size ON levels(size);

-- At most ONE live run per account. Restart replaces the old run; other tabs become stale.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  level_id INTEGER NOT NULL REFERENCES levels(id),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  expires_at INTEGER NOT NULL,
  hearts INTEGER NOT NULL DEFAULT 3 CHECK(hearts BETWEEN 0 AND 3),
  cats TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(cats)),
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'playing' CHECK(status IN ('playing','ready','failed','completed'))
);
-- Idempotency receipts: retrying an ambiguous HTTP result never deducts another heart.
CREATE TABLE IF NOT EXISTS run_moves (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  cell INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('place','remove')),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  PRIMARY KEY(run_id, request_id)
);
CREATE TABLE IF NOT EXISTS completions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level_id INTEGER NOT NULL REFERENCES levels(id),
  elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms > 0),
  completed_at INTEGER NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY(user_id, level_id)
);
CREATE INDEX IF NOT EXISTS idx_completions_top ON completions(level_id, elapsed_ms, completed_at, user_id);
CREATE INDEX IF NOT EXISTS idx_completions_users ON completions(user_id, elapsed_ms);

-- OAuth uses short-lived, single-use state + PKCE and a browser-bound exchange ticket. No cookies.
CREATE TABLE IF NOT EXISTS oauth_flows (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_tickets (
  ticket_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
-- Lease is shared by CLI / workers / server processes, avoiding parallel duplicate jobs.
CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  requested INTEGER NOT NULL CHECK(requested BETWEEN 1 AND 1000),
  created_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')),
  owner TEXT NOT NULL,
  start_level INTEGER,
  end_level INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_generation
  ON generation_jobs((1)) WHERE status IN ('queued','running');

-- Practice is a separate namespace: one retained run per user, never official progress.
CREATE TABLE IF NOT EXISTS practice_runs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  level_id INTEGER NOT NULL REFERENCES levels(id),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  expires_at INTEGER NOT NULL,
  hearts INTEGER NOT NULL DEFAULT 3 CHECK(hearts BETWEEN 0 AND 3),
  cats TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(cats)),
  revision INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'playing' CHECK(status IN ('playing','ready','failed','completed'))
);
CREATE TABLE IF NOT EXISTS practice_moves (
  run_id TEXT NOT NULL REFERENCES practice_runs(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  cell INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('place','remove')),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  PRIMARY KEY(run_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_practice_runs_expires ON practice_runs(expires_at);

-- Password secrets are separate from public identity/progress views.
CREATE TABLE IF NOT EXISTS password_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE CHECK(length(username) BETWEEN 3 AND 24
    AND username NOT GLOB '*[^a-z0-9_]*'),
  algorithm TEXT NOT NULL CHECK(algorithm = 'scrypt'),
  cost INTEGER NOT NULL CHECK(cost = 32768),
  block_size INTEGER NOT NULL CHECK(block_size = 8),
  parallelism INTEGER NOT NULL CHECK(parallelism = 1),
  key_length INTEGER NOT NULL CHECK(key_length = 64),
  salt TEXT NOT NULL CHECK(length(salt) = 32 AND salt NOT GLOB '*[^a-f0-9]*'),
  password_hash TEXT NOT NULL CHECK(length(password_hash) = 128 AND password_hash NOT GLOB '*[^a-f0-9]*')
);
-- Do not allow attaching password credentials to an OAuth or guest identity.
CREATE TRIGGER IF NOT EXISTS password_identity_insert
BEFORE INSERT ON password_credentials
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND auth_provider='password')
BEGIN SELECT RAISE(ABORT, 'password identity required'); END;
CREATE TRIGGER IF NOT EXISTS password_identity_update
BEFORE UPDATE OF user_id ON password_credentials
WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.user_id AND auth_provider='password')
BEGIN SELECT RAISE(ABORT, 'password identity required'); END;
CREATE TRIGGER IF NOT EXISTS password_provider_update
BEFORE UPDATE OF auth_provider ON users
WHEN NEW.auth_provider!='password' AND EXISTS (SELECT 1 FROM password_credentials WHERE user_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'password identity required'); END;
