-- Controlled browser sessions (B01). A session outlives the node's picture and
-- the Runtime process: the row plus the profile directory are what let a
-- restarted Runtime relaunch the same logged-in browser at the same URL.
--
-- No cookies, tokens or page content are stored here. The login state lives
-- only inside the isolated profile on this execution host.
CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  viewport_width INTEGER NOT NULL,
  viewport_height INTEGER NOT NULL,
  device_scale_factor REAL NOT NULL DEFAULT 1,
  -- Absolute path of the private user-data directory (0700). Never a path
  -- inside the user's everyday browser profile.
  profile_dir TEXT NOT NULL,
  headful INTEGER NOT NULL DEFAULT 0,
  -- Closing the node stops the picture; only an explicit terminate ends the
  -- session and deletes the profile.
  keep_alive INTEGER NOT NULL DEFAULT 1,
  -- Bumped by every (re)launch of the browser process for this session.
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'starting',
  reason_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- One session per canvas node: reopening a node reattaches instead of piling
-- up profiles nobody can find again.
CREATE UNIQUE INDEX idx_browser_sessions_node ON browser_sessions(node_id);
CREATE INDEX idx_browser_sessions_workspace ON browser_sessions(workspace_id, created_at);
