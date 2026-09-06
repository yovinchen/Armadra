//! Normalising the settings document: known keys are forced to valid values,
//! unknown keys are passed through, and a patch merges rather than replaces.

use serde_json::{Map, Value};

use crate::terminal::ssh;

use super::*;

/// The whole settings document, normalized: known keys always present with
/// valid values, unknown keys passed through untouched.
pub fn normalize(raw: &Value) -> Value {
    let mut document = match raw {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let terminal = document
        .get("terminal")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let backend = terminal
        .get("backend")
        .and_then(Value::as_str)
        .filter(|choice| BACKEND_CHOICES.contains(choice))
        .unwrap_or(DEFAULT_BACKEND)
        .to_owned();
    let grace = terminal
        .get("detachedGraceMinutes")
        .and_then(Value::as_u64)
        .filter(|minutes| (1..=525_600).contains(minutes))
        .unwrap_or(DEFAULT_DETACHED_GRACE_MINUTES);
    // `0` is a real choice (dormancy off), so it is kept rather than clamped
    // up into the valid range.
    let dormant = terminal
        .get("dormantAfterSeconds")
        .and_then(Value::as_u64)
        .filter(|seconds| {
            *seconds == 0
                || (MIN_DORMANT_AFTER_SECONDS..=MAX_DORMANT_AFTER_SECONDS).contains(seconds)
        })
        .unwrap_or(DEFAULT_DORMANT_AFTER_SECONDS);
    let mut terminal = terminal;
    terminal.insert("backend".into(), Value::String(backend));
    terminal.insert("detachedGraceMinutes".into(), Value::from(grace));
    terminal.insert("dormantAfterSeconds".into(), Value::from(dormant));
    document.insert("terminal".into(), Value::Object(terminal));

    let mut usage = document
        .get("usage")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let enabled = usage
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_USAGE_ENABLED);
    usage.insert("enabled".into(), Value::Bool(enabled));
    // A cadence outside the offered set snaps back to the default rather than
    // being rejected, same rule as `logs.retentionDays`.
    let refresh = usage
        .get("refreshMinutes")
        .and_then(Value::as_u64)
        .filter(|minutes| USAGE_REFRESH_CHOICES.contains(minutes))
        .unwrap_or(DEFAULT_USAGE_REFRESH_MINUTES);
    usage.insert("refreshMinutes".into(), Value::from(refresh));
    let mut providers = usage
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for id in USAGE_PROVIDER_IDS {
        let on = providers.get(*id).and_then(Value::as_bool).unwrap_or(true);
        providers.insert((*id).to_owned(), Value::Bool(on));
    }
    // An id nobody knows about would make the settings page render a switch for
    // a provider the runtime cannot query, so drop it.
    providers.retain(|key, _| USAGE_PROVIDER_IDS.contains(&key.as_str()));
    usage.insert("providers".into(), Value::Object(providers));
    let fallback = usage
        .get("codexCliFallback")
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_CODEX_CLI_FALLBACK);
    usage.insert("codexCliFallback".into(), Value::Bool(fallback));
    let mut cost = usage
        .get("cost")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cost_enabled = cost
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_COST_ENABLED);
    cost.insert("enabled".into(), Value::Bool(cost_enabled));
    usage.insert("cost".into(), Value::Object(cost));
    document.insert("usage".into(), Value::Object(usage));

    // `logs.retentionDays`: a value outside the offered set is snapped back to
    // the default rather than rejected, so hand-edited files still load.
    let mut logs = document
        .get("logs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let retention = logs
        .get("retentionDays")
        .and_then(Value::as_u64)
        .filter(|days| LOG_RETENTION_CHOICES.contains(days))
        .unwrap_or(DEFAULT_LOG_RETENTION_DAYS);
    logs.insert("retentionDays".into(), Value::from(retention));
    document.insert("logs".into(), Value::Object(logs));

    // `updates.*` (S03 §4.1). The channel used to be React state, so it was
    // forgotten on reload and differed between the desktop shell and a browser
    // looking at the same installation; it lives here now. An unknown channel
    // snaps back to stable rather than being rejected: the conservative reading
    // of a broken value is the conservative channel.
    let mut updates = document
        .get("updates")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let channel = updates
        .get("channel")
        .and_then(Value::as_str)
        .filter(|channel| UPDATE_CHANNELS.contains(channel))
        .unwrap_or(DEFAULT_UPDATE_CHANNEL)
        .to_owned();
    updates.insert("channel".into(), Value::String(channel));
    let auto_check = updates
        .get("autoCheck")
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_UPDATE_AUTO_CHECK);
    updates.insert("autoCheck".into(), Value::Bool(auto_check));
    let auto_download = updates
        .get("autoDownload")
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_UPDATE_AUTO_DOWNLOAD);
    updates.insert("autoDownload".into(), Value::Bool(auto_download));
    document.insert("updates".into(), Value::Object(updates));

    // `power.policy` (T02). An unknown value snaps back to the default rather
    // than being rejected: the safest reading of a broken value is the
    // conservative default, not a machine that refuses to sleep.
    let mut power = document
        .get("power")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let policy = power
        .get("policy")
        .and_then(Value::as_str)
        .filter(|policy| POWER_POLICIES.contains(policy))
        .unwrap_or(DEFAULT_POWER_POLICY)
        .to_owned();
    power.insert("policy".into(), Value::String(policy));
    document.insert("power".into(), Value::Object(power));

    // `resources.intervalMs` (T02): clamped, so the panel can offer a choice
    // without the runtime having to trust it.
    let mut resources = document
        .get("resources")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let interval = resources
        .get("intervalMs")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(MIN_RESOURCE_INTERVAL_MS, MAX_RESOURCE_INTERVAL_MS))
        .unwrap_or(DEFAULT_RESOURCE_INTERVAL_MS);
    resources.insert("intervalMs".into(), Value::from(interval));
    document.insert("resources".into(), Value::Object(resources));

    // `browser.*` (B01). `executablePath` is stored exactly as written — an
    // empty string means "detect", and a path that does not exist is reported
    // as unavailable rather than silently replaced by a detected browser.
    let mut browser = document
        .get("browser")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let executable = browser
        .get("executablePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty() && path.len() <= 4_096)
        .unwrap_or_default()
        .to_owned();
    browser.insert("executablePath".into(), Value::String(executable));
    let keep_alive = browser
        .get("keepAlive")
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_BROWSER_KEEP_ALIVE);
    browser.insert("keepAlive".into(), Value::Bool(keep_alive));
    let headful = browser
        .get("headful")
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_BROWSER_HEADFUL);
    browser.insert("headful".into(), Value::Bool(headful));
    document.insert("browser".into(), Value::Object(browser));

    // `language.*` (E01/LSP). Only the scalars are normalised; `servers` and
    // `probes` are the user's map and the probe cache, and both may hold ids
    // this build has never heard of.
    crate::language::settings::normalize(&mut document);

    // `ssh.hosts[]` (plan §21). Entries that would not survive validation are
    // dropped here, so the document the API hands out is exactly the set of
    // hosts a terminal may actually be created for.
    ssh::normalize_hosts(&mut document);

    // `agents.custom[]` (plan §24.1). Same contract as the hosts above: what the
    // API hands back is exactly the set of agents that can actually be started.
    // The section is only written when it already exists, so a settings file
    // that never had a custom agent does not grow an empty one.
    normalize_custom_agents(&mut document);

    Value::Object(document)
}

/// Recursive object merge: `null` deletes a key, objects merge, everything else
/// replaces. Keys the runtime does not know about are merged the same way.
pub(super) fn merge(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            for (key, value) in patch {
                if value.is_null() {
                    base.remove(key);
                } else {
                    merge(base.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        (base, patch) => *base = patch.clone(),
    }
}
