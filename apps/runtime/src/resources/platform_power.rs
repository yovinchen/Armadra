//! Reading the machine's power source — *not* holding it awake. The lease side
//! lives in [`super::power`].
//!
//! `sysinfo` has no battery model, so this is per platform and deliberately
//! small: macOS parses `pmset -g batt`, Linux reads `/sys/class/power_supply`,
//! and everything else reports unknown rather than guessing.

use super::sample::PowerSource;

#[cfg(target_os = "macos")]
pub fn power_source() -> PowerSource {
    let Ok(output) = std::process::Command::new("/usr/bin/pmset")
        .args(["-g", "batt"])
        .output()
    else {
        return PowerSource::default();
    };
    parse_pmset(&String::from_utf8_lossy(&output.stdout))
}

/// `pmset -g batt` prints the source on the first line and one line per
/// battery:
///
/// ```text
/// Now drawing from 'AC Power'
///  -InternalBattery-0 (id=…)  91%; charging; 0:32 remaining present: true
/// ```
///
/// A desktop with no battery prints only the source line, which is exactly the
/// "on mains, no battery percentage" case: `source` is set, the rest is `None`.
#[cfg(target_os = "macos")]
fn parse_pmset(text: &str) -> PowerSource {
    let mut power = PowerSource::default();
    if text.contains("'AC Power'") {
        power.source = Some("ac");
    } else if text.contains("'Battery Power'") {
        power.source = Some("battery");
    }
    for line in text.lines().skip(1) {
        let Some((percent, rest)) = line.split_once('%') else {
            continue;
        };
        let Some(value) = percent
            .rsplit(char::is_whitespace)
            .next()
            .and_then(|value| value.parse::<f64>().ok())
        else {
            continue;
        };
        if !(0.0..=100.0).contains(&value) {
            continue;
        }
        power.battery_percent = Some(value);
        power.charging = Some(rest.contains("charging") && !rest.contains("discharging"));
        break;
    }
    power
}

#[cfg(target_os = "linux")]
pub fn power_source() -> PowerSource {
    use std::path::Path;

    let root = Path::new("/sys/class/power_supply");
    let Ok(entries) = std::fs::read_dir(root) else {
        return PowerSource::default();
    };
    let read = |path: std::path::PathBuf| -> Option<String> {
        std::fs::read_to_string(path)
            .ok()
            .map(|value| value.trim().to_owned())
    };
    let mut power = PowerSource::default();
    let mut mains: Option<bool> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        let kind = read(path.join("type")).unwrap_or_default();
        match kind.as_str() {
            "Mains" => {
                if let Some(online) = read(path.join("online")) {
                    mains = Some(mains.unwrap_or(false) || online == "1");
                }
            }
            "Battery" if power.battery_percent.is_none() => {
                power.battery_percent = read(path.join("capacity"))
                    .and_then(|value| value.parse::<f64>().ok())
                    .filter(|value| (0.0..=100.0).contains(value));
                power.charging = read(path.join("status")).map(|status| status == "Charging");
            }
            _ => {}
        }
    }
    power.source = mains.map(|online| if online { "ac" } else { "battery" });
    power
}

/// Windows and anything else: unknown. `GetSystemPowerStatus` would answer
/// this, but nothing here can be verified on a real machine in this round, and
/// an unverified number is worse than an honest blank (design §8).
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn power_source() -> PowerSource {
    PowerSource::default()
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn a_laptop_on_mains_reports_both_the_source_and_the_charge() {
        let power = parse_pmset(
            "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1234)\t91%; charging; 0:32 remaining present: true\n",
        );
        assert_eq!(power.source, Some("ac"));
        assert_eq!(power.battery_percent, Some(91.0));
        assert_eq!(power.charging, Some(true));
    }

    #[test]
    fn discharging_is_not_read_as_charging() {
        let power = parse_pmset(
            "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t64%; discharging; 2:10 remaining present: true\n",
        );
        assert_eq!(power.source, Some("battery"));
        assert_eq!(power.battery_percent, Some(64.0));
        assert_eq!(power.charging, Some(false));
    }

    #[test]
    fn a_desktop_reports_mains_with_no_battery_number() {
        let power = parse_pmset("Now drawing from 'AC Power'\n");
        assert_eq!(power.source, Some("ac"));
        assert_eq!(power.battery_percent, None);
        assert_eq!(power.charging, None);
    }

    #[test]
    fn unparseable_output_stays_unknown_rather_than_zero() {
        let power = parse_pmset("something else entirely\n");
        assert_eq!(power.source, None);
        assert_eq!(power.battery_percent, None);
    }
}
