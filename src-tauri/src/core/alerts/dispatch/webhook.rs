use crate::core::alerts::{
    dispatch::run_with_retry, template::TemplateContext, types::WebhookAction,
};
use log::debug;

/// Fire an HTTP webhook request with the rendered body template.
///
/// Respects the `tls_verify` setting by using the appropriate pooled client.
/// Retries up to `action.retry_count` times on failure using shared logic.
pub async fn dispatch(
    action: &WebhookAction,
    ctx: &TemplateContext,
    client: &reqwest::Client,
) -> Result<(), String> {
    let body = ctx.render(&action.body_template);
    let url = ctx.render(&action.url);

    let method = reqwest::Method::from_bytes(action.method.to_uppercase().as_bytes())
        .map_err(|e| format!("Invalid HTTP method '{}': {e}", action.method))?;

    run_with_retry(
        &format!("Webhook '{}'", action.common.name),
        action.retry_count,
        || {
            let method = method.clone();
            let url = url.clone();
            let body = body.clone();

            async move {
                let mut req_builder = client.request(method, &url).body(body);

                for (k, v) in &action.headers {
                    let rendered_v = ctx.render(v);
                    req_builder = req_builder.header(k.as_str(), rendered_v);
                }

                let resp = req_builder
                    .send()
                    .await
                    .map_err(|e| format!("Request error: {e}"))?;

                let status = resp.status();
                if status.is_success() {
                    debug!(
                        "📡 Webhook '{}' completed successfully: {url}",
                        action.common.name
                    );
                    return Ok(());
                }

                Err(format!(
                    "HTTP {}: {}",
                    status.as_u16(),
                    resp.text().await.unwrap_or_default()
                ))
            }
        },
    )
    .await
}
