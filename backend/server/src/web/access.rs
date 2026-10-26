//! Revoke file requests and response bodies when the interface locks.
use super::state::{ApiResponse, WebServerState};
use axum::{
    body::Body,
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use futures::StreamExt;
use rclone_manager_core::services::settings::access::{self, VaultAccess};
use std::sync::Arc;

fn locked_response() -> Response {
    (
        StatusCode::LOCKED,
        axum::Json(ApiResponse::<()>::error(access::locked_error())),
    )
        .into_response()
}

pub async fn file_access_middleware(
    State(state): State<WebServerState>,
    request: Request,
    next: Next,
) -> Response {
    if access::is_locked(&state.app_handle) {
        return locked_response();
    }
    let Some(access) = state.app_handle.try_state::<Arc<VaultAccess>>() else {
        return next.run(request).await;
    };
    let revision = access.revision();
    let mut changes = access.subscribe();
    if !access.permits(revision) {
        return locked_response();
    }
    let response = tokio::select! {
        biased;
        _ = changes.changed() => return locked_response(),
        response = next.run(request) => response,
    };
    if !access.permits(revision) || access::is_locked(&state.app_handle) {
        return locked_response();
    }
    let (mut parts, body) = response.into_parts();
    parts.headers.insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    let mut stream = body.into_data_stream();
    let body = async_stream::stream! {
        loop {
            let chunk = tokio::select! {
                biased;
                _ = changes.changed() => break,
                chunk = stream.next() => chunk,
            };
            if !access.permits(revision) || access::is_locked(&state.app_handle) { break; }
            let Some(chunk) = chunk else { break; };
            yield chunk;
        }
    };
    Response::from_parts(parts, Body::from_stream(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router, body::to_bytes, http::Request, middleware::from_fn_with_state, routing::get,
    };
    use rclone_manager_core::{
        context::AppHandle,
        services::{bridge::EventBridge, settings::schema::AppSettings},
    };
    use tower::ServiceExt;

    fn state(directory: &std::path::Path) -> (WebServerState, Arc<VaultAccess>) {
        let manager = rcman::SettingsManager::builder("http-access-test", "1")
            .with_config_dir(directory)
            .with_vault()
            .with_schema::<AppSettings>()
            .build()
            .unwrap();
        manager.enable_vault("password").unwrap();
        let access = Arc::new(VaultAccess::new(directory, &manager).unwrap());
        access.unlock();
        let app_handle = AppHandle::default();
        app_handle.manage(manager);
        app_handle.manage(access.clone());
        let event_bridge = Arc::new(EventBridge::new(10, None));
        event_bridge.set_frontend_access(access.clone());
        (
            WebServerState {
                app_handle,
                event_bridge,
                auth_credentials: None,
                sessions: Arc::default(),
                tls: false,
            },
            access,
        )
    }

    #[tokio::test]
    async fn locked_api_rejects_files_uploads_and_queries_but_exposes_public_status() {
        let directory = tempfile::tempdir().unwrap();
        let (state, access) = state(directory.path());
        access.lock();
        let router = crate::web::routes::build_api_router(state);
        for path in [
            "/stream?path=/private",
            "/stream/remote?remote=private&path=file",
            "/stream/audio-cover?path=/private",
            "/upload",
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method(if path == "/upload" { "POST" } else { "GET" })
                        .uri(path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::LOCKED, "{path}");
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert!(!String::from_utf8_lossy(&body).contains("/private"));
        }
        for command in [
            "load_settings",
            "list_workflows",
            "get_automations",
            "get_vault_info",
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/invoke")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::json!({"command": command, "args": {}}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(body["success"], command == "get_vault_info", "{command}");
        }
    }

    #[tokio::test]
    async fn an_open_download_stops_after_lock_even_if_unlocked_before_its_next_chunk() {
        let directory = tempfile::tempdir().unwrap();
        let (state, access) = state(directory.path());
        let router = Router::new()
            .route(
                "/stream",
                get(|| async {
                    Body::from_stream(futures::stream::repeat(Ok::<_, std::convert::Infallible>(
                        "private bytes",
                    )))
                }),
            )
            .layer(from_fn_with_state(state, file_access_middleware));
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.headers()[axum::http::header::CACHE_CONTROL],
            "no-store"
        );
        let mut body = response.into_body().into_data_stream();
        assert_eq!(body.next().await.unwrap().unwrap(), "private bytes");
        access.lock();
        access.unlock();
        assert!(body.next().await.is_none());
    }

    #[tokio::test]
    async fn locking_cancels_an_inflight_file_handler() {
        let directory = tempfile::tempdir().unwrap();
        let (state, access) = state(directory.path());
        let entered = Arc::new(tokio::sync::Notify::new());
        let handler_entered = entered.clone();
        let router = Router::new()
            .route(
                "/stream",
                get(move || {
                    let entered = handler_entered.clone();
                    async move {
                        entered.notify_one();
                        std::future::pending::<&'static str>().await
                    }
                }),
            )
            .layer(from_fn_with_state(state, file_access_middleware));
        let response = crate::utils::spawn(async move {
            router
                .oneshot(
                    Request::builder()
                        .uri("/stream")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        entered.notified().await;
        access.lock();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), response)
                .await
                .unwrap()
                .unwrap()
                .status(),
            StatusCode::LOCKED
        );
    }

    #[tokio::test]
    async fn existing_sse_connections_do_not_expose_locked_or_stale_job_events() {
        use crate::utils::types::events::{JOB_CACHE_CHANGED, VAULT_STATE_CHANGED};
        let directory = tempfile::tempdir().unwrap();
        let (state, access) = state(directory.path());
        let sse = crate::web::handlers::sse_handler(State(state.clone())).await;
        let mut body = sse.into_response().into_body().into_data_stream();
        state
            .event_bridge
            .emit(JOB_CACHE_CHANGED, serde_json::json!({"private": true}));
        state
            .event_bridge
            .emit(VAULT_STATE_CHANGED, serde_json::json!({"isLocked": false}));
        access.lock();
        state.event_bridge.emit(
            JOB_CACHE_CHANGED,
            serde_json::json!({"lockedPrivate": true}),
        );
        state
            .event_bridge
            .emit(VAULT_STATE_CHANGED, serde_json::json!({"isLocked": true}));
        let chunk = body.next().await.unwrap().unwrap();
        let chunk = String::from_utf8_lossy(&chunk);
        assert!(chunk.contains(VAULT_STATE_CHANGED));
        assert!(!chunk.contains("private"));
        assert!(!chunk.contains("lockedPrivate"));
        assert!(!chunk.contains("\"isLocked\":false"));
        access.unlock();
        state
            .event_bridge
            .emit(JOB_CACHE_CHANGED, serde_json::json!({"fresh": true}));
        let chunk = body.next().await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&chunk).contains("fresh"));
    }
}
