use rclone_manager_core::app::dispatch::bridge_dispatch;
pub fn generate_bridge_router() -> axum::Router<crate::web::WebServerState> {
    use crate::web::{ApiResponse, WebServerState};
    use axum::{
        Router,
        extract::{Json, State},
        response::{IntoResponse, Json as AxumJson},
        routing::post,
    };
    use serde::Deserialize;
    use serde_json::Value;

    #[derive(Deserialize)]
    struct InvokeBody {
        command: String,
        args: Value,
    }

    Router::new().route(
        "/invoke",
        post(
            |State(state): State<WebServerState>, Json(body): Json<InvokeBody>| async move {
                match bridge_dispatch(&state.app_handle, &body.command, body.args).await {
                    Ok(res) => AxumJson(ApiResponse::success(res)).into_response(),
                    Err(error) => invoke_error(&body.command, error),
                }
            },
        ),
    )
}

fn invoke_error(command: &str, error: serde_json::Value) -> axum::response::Response {
    use axum::response::IntoResponse;
    let message = error
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| error.to_string());
    log::error!("Invoke command '{command}' failed: {message}");
    // Preserve the existing error string contract so localized errors still decode.
    (
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(serde_json::json!({
            "success": false, "error": message, "command": command,
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn invoke_errors_identify_command_without_changing_translation_payload() {
        for error in [
            serde_json::json!("remote unavailable"),
            serde_json::json!({"key": "backendErrors.test", "params": {"remote": "Google Drive:"}}),
        ] {
            let response = invoke_error("get_disk_usage", error.clone());
            assert_eq!(
                response.status(),
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            );
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["command"], "get_disk_usage");
            assert_eq!(body["success"], false);
            assert_eq!(
                body["error"],
                error
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| error.to_string())
            );
            assert!(body.get("args").is_none());
        }
    }
}
