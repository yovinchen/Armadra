-- Where a workspace's files, search and Git run (H02). An empty string is the
-- machine this Runtime is on, which is what every existing row means and what
-- the whole product did before remote Workers existed. A non-empty value is a
-- `settings.ssh.hosts[].id`; `root_path` is then a path on *that* host and the
-- local filesystem is never consulted for it.
ALTER TABLE workspaces ADD COLUMN execution_host_id TEXT NOT NULL DEFAULT '';
