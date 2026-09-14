//! Read-only Gemini CLI quota lookup. The CLI remains responsible for signing
//! in and renewing OAuth credentials; this module never changes its files.
//! Endpoint and bucket fields follow google-gemini/gemini-cli's code_assist API.

use anyhow::Context;
use serde::Deserialize;

use super::{
    CredentialSource, ProviderReport, ProviderResult, UsageFailure, UsageWindow, clamp_percent,
    home_dir,
};

pub const ID: &str = "gemini";
const LOAD_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const QUOTA_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

#[derive(Deserialize)]
struct Credentials {
    access_token: Option<String>,
    expiry_date: Option<i64>,
}

fn token_from_payload(raw: &str, now: i64) -> anyhow::Result<String> {
    let credentials: Credentials = serde_json::from_str(raw).map_err(|error| {
        UsageFailure::UnreadableCredentials
            .with(error)
            .context("Gemini credentials did not parse")
    })?;
    if credentials.expiry_date.is_some_and(|expiry| expiry <= now) {
        return Err(UsageFailure::ExpiredCredentials
            .with("Gemini credentials have expired; run the CLI to renew them"));
    }
    credentials
        .access_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| {
            UsageFailure::UnreadableCredentials
                .with("Gemini credentials do not contain an access token")
        })
}

pub async fn fetch(client: &reqwest::Client) -> (ProviderResult, CredentialSource) {
    let Some(home) = home_dir() else {
        return (Ok(None), CredentialSource::None);
    };
    let path = home.join(".gemini/oauth_creds.json");
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (Ok(None), CredentialSource::None);
        }
        Err(_) => {
            return (
                Err(UsageFailure::UnreadableCredentials
                    .with("Gemini credentials could not be read")),
                CredentialSource::File,
            );
        }
    };
    let result = match token_from_payload(&raw, chrono::Utc::now().timestamp_millis()) {
        Ok(token) => fetch_token(client, &token).await,
        Err(error) => Err(error),
    };
    (result, CredentialSource::File)
}

async fn post(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    body: serde_json::Value,
) -> anyhow::Result<serde_json::Value> {
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            UsageFailure::Network
                .with(error)
                .context("request to Gemini quota service failed")
        })?;
    if !response.status().is_success() {
        // Do not read the error body: it may contain account or project data.
        return Err(UsageFailure::from_status(response.status()).with(format!(
            "Gemini quota service answered {}",
            response.status()
        )));
    }
    response.json().await.map_err(|error| {
        UsageFailure::Parse
            .with(error)
            .context("Gemini quota response did not parse")
    })
}

async fn fetch_token(client: &reqwest::Client, token: &str) -> ProviderResult {
    let project = match std::env::var("GOOGLE_CLOUD_PROJECT")
        .ok()
        .filter(|project| !project.trim().is_empty())
    {
        Some(project) => project,
        None => {
            let response = post(client, LOAD_URL, token, serde_json::json!({
                "metadata": { "ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI" }
            })).await?;
            response
                .get("cloudaicompanionProject")
                .and_then(serde_json::Value::as_str)
                .filter(|project| !project.is_empty())
                .context("Gemini account has no Code Assist project")?
                .to_owned()
        }
    };
    let response = post(
        client,
        QUOTA_URL,
        token,
        serde_json::json!({"project": project}),
    )
    .await?;
    Ok(Some(ProviderReport::from_windows(windows(response))))
}

fn windows(response: serde_json::Value) -> Vec<UsageWindow> {
    let buckets = response
        .as_array()
        .or_else(|| response.get("buckets")?.as_array());
    buckets
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, bucket)| {
            let fraction = bucket.get("remainingFraction")?.as_f64()?;
            if !fraction.is_finite() || !(0.0..=1.0).contains(&fraction) {
                return None;
            }
            let model = bucket.get("modelId")?.as_str()?.trim();
            if model.is_empty() {
                return None;
            }
            let resets_at = bucket
                .get("resetTime")
                .and_then(serde_json::Value::as_str)
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.to_rfc3339());
            Some(UsageWindow {
                key: format!("{model}:{index}"),
                // The API does not supply a window duration. Do not invent an
                // hourly or daily period from the reset timestamp.
                label: "quota".to_owned(),
                group: Some(model.to_owned()),
                used_percent: clamp_percent((1.0 - fraction) * 100.0),
                unlimited: false,
                resets_at,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_remaining_fraction_without_merging_independent_models() {
        let result = windows(serde_json::json!({ "buckets": [
            { "modelId": "gemini-pro", "remainingFraction": 0.754, "resetTime": "2026-09-05T12:00:00Z" },
            { "modelId": "gemini-flash", "remainingFraction": 0.754, "resetTime": "2026-09-05T12:00:00Z" }
        ], "project": "private-project" }));
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].used_percent, 24.6);
        assert_eq!(result[0].label, "quota");
        assert_ne!(result[0].key, result[1].key);
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("private-project")
        );
    }

    #[test]
    fn does_not_turn_missing_or_invalid_fractions_into_zero_usage() {
        let result = windows(serde_json::json!([
            { "modelId": "a", "remainingFraction": 1.0, "resetTime": "unknown" },
            { "modelId": "b", "remainingFraction": null },
            { "modelId": "c", "remainingFraction": -1.0 },
            { "modelId": "d", "remainingFraction": 1.1 },
            { "remainingFraction": 0.3 }
        ]));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].used_percent, 0.0);
        assert!(result[0].resets_at.is_none());
    }

    #[test]
    fn expired_credentials_are_not_sent_and_missing_expiry_is_accepted() {
        assert!(token_from_payload(r#"{"access_token":"test","expiry_date":100}"#, 100).is_err());
        assert_eq!(
            token_from_payload(r#"{"access_token":"test"}"#, 100).unwrap(),
            "test"
        );
        assert!(token_from_payload(r#"{"access_token":" "}"#, 100).is_err());
    }
}
