use crate::core::alerts::{template::TemplateContext, types::WebhookAction};
use log::{debug, warn};
use std::time::Duration;

/// Build a reqwest client with appropriate TLS verification settings.
/// The client will be automatically cleaned up when the dispatch completes.
fn build_client(tls_verify: bool, timeout: Duration) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(timeout);

    if !tls_verify {
        builder = builder.danger_accept_invalid_certs(true);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// Fire an HTTP webhook request with the rendered body template.
///
/// Respects the `tls_verify` setting by creating a custom client when needed.
/// The client is a local variable that gets automatically cleaned up when this function returns.
/// Retries up to `action.retry_count` times on failure.
pub async fn dispatch(action: &WebhookAction, ctx: &TemplateContext) -> Result<(), String> {
    debug!(
        "📡 Creating client for webhook: '{}' (tls_verify={})",
        action.name, action.tls_verify
    );

    let body = ctx.render(&action.body_template);

    let method = reqwest::Method::from_bytes(action.method.to_uppercase().as_bytes())
        .map_err(|e| format!("Invalid HTTP method '{}': {e}", action.method))?;

    let timeout = Duration::from_secs(action.timeout_secs.max(1));

    // Create a client with appropriate TLS verification settings
    let client = build_client(action.tls_verify, timeout)?;

    let mut attempt = 0u8;
    let max_attempts = action.retry_count + 1;

    loop {
        attempt += 1;

        let mut req_builder = client
            .request(method.clone(), &action.url)
            .body(body.clone());

        for (k, v) in &action.headers {
            req_builder = req_builder.header(k.as_str(), v.as_str());
        }

        match req_builder.send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    debug!(
                        "📡 Webhook '{}' → {} {} OK (tls_verify={})",
                        action.name, action.method, action.url, action.tls_verify
                    );
                    return Ok(());
                }
                let err = format!(
                    "Webhook '{}' returned HTTP {}: {}",
                    action.name,
                    status.as_u16(),
                    resp.text().await.unwrap_or_default()
                );
                if attempt >= max_attempts {
                    return Err(err);
                }
                warn!("{err} — retrying ({attempt}/{max_attempts})");
            }
            Err(e) => {
                let err = format!("Webhook '{}' request error: {e}", action.name);
                if attempt >= max_attempts {
                    return Err(err);
                }
                warn!("{err} — retrying ({attempt}/{max_attempts})");
            }
        }

        // Brief back-off before retry
        tokio::time::sleep(Duration::from_secs(u64::from(attempt))).await;
    }
}
