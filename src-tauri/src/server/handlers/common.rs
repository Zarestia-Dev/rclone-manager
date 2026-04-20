use crate::server::state::{ApiResponse, AppError};
use axum::Json;

pub type ApiResult<T> = Result<Json<ApiResponse<T>>, AppError>;

pub async fn root_handler() -> &'static str {
    "RClone Manager Headless API Server"
}

pub async fn health_handler() -> Json<ApiResponse<String>> {
    Json(ApiResponse::success("OK".to_string()))
}
