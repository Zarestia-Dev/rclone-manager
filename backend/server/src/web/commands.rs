use rclone_manager_core::app::dispatch::bridge_dispatch;
pub fn generate_bridge_router() -> axum::Router<crate::web::WebServerState> {
    use crate::web::{ApiResponse, AppError, WebServerState};
    use axum::{
        Router,
        extract::{Json, State},
        response::Json as AxumJson,
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
                let res = bridge_dispatch(&state.app_handle, &body.command, body.args)
                    .await
                    .map_err(|e| {
                        AppError::InternalServerError(anyhow::Error::msg(
                            e.as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| e.to_string()),
                        ))
                    })?;
                Ok::<AxumJson<ApiResponse<Value>>, AppError>(AxumJson(ApiResponse::success(res)))
            },
        ),
    )
}
