use crate::core::alerts::{
    dispatch::run_with_retry, template::TemplateContext, types::WebhookAction,
};

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

    let rendered_headers: Vec<(String, String)> = action
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), ctx.render(v)))
        .collect();

    let method = reqwest::Method::from_bytes(action.method.to_uppercase().as_bytes())
        .map_err(|e| format!("Invalid HTTP method '{}': {e}", action.method))?;

    run_with_retry(
        &format!("Webhook '{}'", action.common.name),
        action.retry_count,
        || {
            let method = method.clone();
            let url = url.clone();
            let body = body.clone();
            let headers = rendered_headers.clone();

            async move {
                let mut req_builder = client.request(method, &url).body(body);

                for (k, v) in headers {
                    req_builder = req_builder.header(k, v);
                }

                let resp = req_builder
                    .send()
                    .await
                    .map_err(|e| format!("Request error: {e}"))?;

                let status = resp.status();
                if status.is_success() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::alerts::types::ActionCommon;
    use std::collections::HashMap;
    use std::net::SocketAddr;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct MockServer {
        pub addr: SocketAddr,
        pub rx: tokio::sync::mpsc::Receiver<String>,
    }

    impl MockServer {
        pub async fn start(responses: Vec<(u16, String)>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let (tx, rx) = tokio::sync::mpsc::channel(10);

            tokio::spawn(async move {
                let mut response_iter = responses.into_iter();
                while let Ok((mut stream, _)) = listener.accept().await {
                    let mut buf = [0u8; 4096];
                    if let Ok(n) = stream.read(&mut buf).await {
                        let req_str = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = tx.send(req_str).await;

                        let (code, body) = response_iter.next().unwrap_or((200, "OK".to_string()));
                        let status_text = match code {
                            200 => "OK",
                            201 => "Created",
                            500 => "Internal Server Error",
                            _ => "Unknown",
                        };
                        let response = format!(
                            "HTTP/1.1 {code} {status_text}\r\nContent-Length: {}\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(response.as_bytes()).await;
                    }
                }
            });

            Self { addr, rx }
        }
    }

    fn sample_context() -> TemplateContext {
        TemplateContext {
            title: "Sync Job".to_string(),
            body: "Successfully transferred 10 files".to_string(),
            severity: "info".to_string(),
            severity_code: 1,
            event_kind: "job".to_string(),
            remote: "gdrive".to_string(),
            profile: "default".to_string(),
            backend: "drive".to_string(),
            operation: "sync".to_string(),
            origin: crate::utils::types::origin::Origin::Internal,
            timestamp: "2026-07-15T00:00:00Z".to_string(),
            rule_id: "rule-123".to_string(),
            rule_name: "Success Rule".to_string(),
            source: Some("local-folder".to_string()),
            destination: Some("remote-folder".to_string()),
        }
    }

    #[tokio::test]
    async fn test_webhook_success() {
        let server = MockServer::start(vec![(200, "OK response".to_string())]).await;

        let mut headers = HashMap::new();
        headers.insert("X-Alert-Severity".to_string(), "{{severity}}".to_string());

        let action = WebhookAction {
            common: ActionCommon {
                id: "test-id".to_string(),
                name: "Test Webhook Action".to_string(),
                enabled: true,
            },
            url: format!("http://127.0.0.1:{}/test-endpoint", server.addr.port()),
            method: "POST".to_string(),
            headers,
            body_template: "Alert: {{title}} - {{body}}".to_string(),
            timeout_secs: 5,
            tls_verify: false,
            retry_count: 0,
        };

        let ctx = sample_context();
        let client = reqwest::Client::new();

        let result = dispatch(&action, &ctx, &client).await;
        assert!(result.is_ok());

        let mut rx = server.rx;
        let request = rx.recv().await.expect("Should have received request");

        assert!(request.contains("POST /test-endpoint HTTP/1.1"));
        assert!(request.contains("x-alert-severity: info"));
        assert!(request.contains("Alert: Sync Job - Successfully transferred 10 files"));
    }

    #[tokio::test]
    async fn test_webhook_retry_success() {
        let server = MockServer::start(vec![
            (500, "Error 1".to_string()),
            (200, "Success after retry".to_string()),
        ])
        .await;

        let action = WebhookAction {
            common: ActionCommon {
                id: "test-retry-id".to_string(),
                name: "Test Webhook Retry".to_string(),
                enabled: true,
            },
            url: format!("http://127.0.0.1:{}", server.addr.port()),
            method: "GET".to_string(),
            headers: HashMap::new(),
            body_template: "".to_string(),
            timeout_secs: 5,
            tls_verify: false,
            retry_count: 1, // 1 retry means total 2 attempts
        };

        let ctx = sample_context();
        let client = reqwest::Client::new();

        let result = dispatch(&action, &ctx, &client).await;
        assert!(result.is_ok());

        let mut rx = server.rx;
        let req1 = rx.recv().await.expect("Should receive first attempt");
        let req2 = rx.recv().await.expect("Should receive retry attempt");

        assert!(req1.contains("GET / HTTP/1.1"));
        assert!(req2.contains("GET / HTTP/1.1"));
    }

    #[tokio::test]
    async fn test_webhook_failure_after_retries() {
        let server = MockServer::start(vec![
            (500, "Error 1".to_string()),
            (500, "Error 2".to_string()),
            (200, "Too late".to_string()),
        ])
        .await;

        let action = WebhookAction {
            common: ActionCommon {
                id: "test-fail-id".to_string(),
                name: "Test Webhook Fail".to_string(),
                enabled: true,
            },
            url: format!("http://127.0.0.1:{}", server.addr.port()),
            method: "POST".to_string(),
            headers: HashMap::new(),
            body_template: "".to_string(),
            timeout_secs: 5,
            tls_verify: false,
            retry_count: 1, // 1 retry means total 2 attempts
        };

        let ctx = sample_context();
        let client = reqwest::Client::new();

        let result = dispatch(&action, &ctx, &client).await;
        assert!(result.is_err());

        let mut rx = server.rx;
        let _ = rx.recv().await.expect("Should receive first attempt");
        let _ = rx.recv().await.expect("Should receive second attempt");
        assert!(
            rx.try_recv().is_err(),
            "Should not have made a third attempt"
        );
    }
}
