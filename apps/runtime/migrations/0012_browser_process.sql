-- What a restarted Runtime needs to tell "my browser is still running" from
-- "somebody else's process now owns this profile" (B01, §2.10).
--
-- A SIGKILLed Runtime never gets to close Chrome, so the profile keeps its
-- `SingletonLock` and the browser keeps running. On the way back up the
-- session is only re-attached when the recorded pid is alive *and* started at
-- the recorded time: a pid alone is not an identity, because the number is
-- reused. A mismatch is reported as `profile_locked` and waits for the user,
-- because killing a process this Runtime did not start is not a decision code
-- gets to make.
--
-- Written on a successful launch and cleared on an orderly exit. No cookies,
-- no tokens, no page content: the login state still lives only in the profile
-- directory on this execution host.
ALTER TABLE browser_sessions ADD COLUMN pid INTEGER NOT NULL DEFAULT 0;
-- Milliseconds since the epoch, as the operating system reports the process's
-- own start time. Zero means "not recorded", which is treated as no identity
-- at all rather than as a match.
ALTER TABLE browser_sessions ADD COLUMN pid_started_at INTEGER NOT NULL DEFAULT 0;
-- The loopback DevTools port. `DevToolsActivePort` inside the profile is the
-- authority; this is what lets a re-attach start before reading the file, and
-- what says which port a still-running browser was reachable on.
ALTER TABLE browser_sessions ADD COLUMN cdp_port INTEGER NOT NULL DEFAULT 0;
-- The control lease is memory state and comes back free, but its generation
-- keeps climbing, so a client holding a pre-restart generation is refused
-- instead of being handed a lease that looks like its own (§2.6).
ALTER TABLE browser_sessions ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;
-- Tabs are not stored. A restart restores the active tab's URL and says so on
-- the node; pretending the other tabs came back would be worse than losing
-- them visibly (§2.12).
ALTER TABLE browser_sessions ADD COLUMN active_tab_url TEXT NOT NULL DEFAULT '';
