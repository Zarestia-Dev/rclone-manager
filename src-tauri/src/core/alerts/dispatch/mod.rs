pub mod email;
pub mod mqtt;
pub mod os_toast;
pub mod script;
pub mod telegram;
pub mod webhook;

use std::time::Duration;

pub struct DispatchContext {
    pub client: reqwest::Client,
    pub insecure_client: reqwest::Client,
}

impl Default for DispatchContext {
    fn default() -> Self {
        Self::new()
    }
}

impl DispatchContext {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();

        let insecure_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .danger_accept_invalid_certs(true)
            .build()
            .unwrap_or_default();

        Self {
            client,
            insecure_client,
        }
    }
}

/// Helper to run an async operation with linear backoff retry logic.
pub async fn run_with_retry<F, Fut, T>(
    name: &str,
    retry_count: u8,
    mut operation: F,
) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let max_attempts = retry_count + 1;
    let mut attempt = 0u8;

    loop {
        attempt += 1;
        match operation().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                if attempt >= max_attempts {
                    return Err(e);
                }
                log::warn!("{name} failed: {e} — retrying ({attempt}/{max_attempts})");
                tokio::time::sleep(Duration::from_secs(u64::from(attempt))).await;
            }
        }
    }
}
