//! Common handlers (root, health)

use crate::server::state::ApiResponse;
use axum::response::Json;

pub async fn root_handler() -> &'static str {
    "RClone Manager Headless API Server"
}

pub async fn health_handler() -> Json<ApiResponse<String>> {
    Json(ApiResponse::success("OK".to_string()))
}
