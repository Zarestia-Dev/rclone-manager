use super::{ApiResponse, WebServerState};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use rclone_manager_core::{
    app::dispatch::{bridge_dispatch, is_command},
    context::AppHandle,
    services::settings::access,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct InvokeBody {
    command: String,
    args: Value,
}

pub fn generate_bridge_router() -> Router<WebServerState> {
    Router::new().route("/invoke", post(invoke))
}

async fn invoke(State(state): State<WebServerState>, Json(body): Json<InvokeBody>) -> Response {
    if !is_command(&body.command) {
        return failure(
            StatusCode::NOT_FOUND,
            format!("Command '{}' not found", body.command),
        );
    }
    match bridge_dispatch(&state.app_handle, &body.command, body.args).await {
        Ok(result) => Json(ApiResponse::success(result)).into_response(),
        Err(error) => invoke_error(&state.app_handle, &body.command, &error),
    }
}

/// Plain errors arrive as strings; localized ones as `{key, params}` objects that
/// the frontend decodes from their JSON text.
fn error_message(error: &Value) -> String {
    error
        .as_str()
        .map_or_else(|| error.to_string(), str::to_owned)
}

fn failure(status: StatusCode, message: String) -> Response {
    (status, Json(ApiResponse::<()>::error(message))).into_response()
}

fn invoke_error(app: &AppHandle, command: &str, error: &Value) -> Response {
    let message = error_message(error);
    // A locked interface is an expected answer, not a failure of the command.
    if access::is_locked(app) && !access::allowed_when_locked(command) {
        log::debug!("Invoke command '{command}' refused while locked");
        return failure(StatusCode::LOCKED, message);
    }
    log::error!("Invoke command '{command}' failed: {message}");
    failure(StatusCode::INTERNAL_SERVER_ERROR, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn body_of(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn command_errors_keep_their_translation_payload_in_the_shared_error_shape() {
        let app = AppHandle::default();
        for (error, message) in [
            (json!("remote unavailable"), "remote unavailable"),
            (
                json!({"key": "backendErrors.test", "params": {"remote": "Google Drive:"}}),
                r#"{"key":"backendErrors.test","params":{"remote":"Google Drive:"}}"#,
            ),
        ] {
            let response = invoke_error(&app, "get_disk_usage", &error);
            assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(
                body_of(response).await,
                json!({"success": false, "error": message})
            );
        }
    }

    #[tokio::test]
    async fn unknown_commands_are_not_found() {
        let state = WebServerState::new(
            AppHandle::default(),
            std::sync::Arc::new(rclone_manager_core::services::bridge::EventBridge::new(
                1, None,
            )),
            None,
            false,
        );
        let response = invoke(
            State(state),
            Json(InvokeBody {
                command: "no_such_command".into(),
                args: json!({}),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(body_of(response).await["success"], false);
    }
}
