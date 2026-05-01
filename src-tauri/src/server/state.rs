use axum::{
    extract::State,
    http::{StatusCode, header::AUTHORIZATION},
    middleware::Next,
    response::{IntoResponse, Json},
};
use log::error;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::broadcast;

/// Shared state for web server handlers
#[derive(Clone)]
pub struct WebServerState {
    pub app_handle: AppHandle,
    pub event_tx: Arc<broadcast::Sender<TauriEvent>>,
    pub auth_credentials: Option<(String, String)>,
}

/// Event message for SSE
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TauriEvent {
    pub event: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn error(message: String) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(message),
        }
    }
}

/// Custom error type for API handlers
#[derive(Debug)]
pub enum AppError {
    BadRequest(anyhow::Error),
    InternalServerError(anyhow::Error),
    NotFound(String),
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self::InternalServerError(err.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            AppError::BadRequest(e) => (StatusCode::BAD_REQUEST, e.to_string()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            AppError::InternalServerError(e) => {
                error!("API Error: {e:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
            }
        };

        (status, Json(ApiResponse::<()>::error(message))).into_response()
    }
}

/// Authentication middleware for API endpoints
pub async fn auth_middleware(
    State(state): State<WebServerState>,
    request: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Result<axum::response::Response, StatusCode> {
    // No credentials configured — allow all requests through.
    let Some((_, expected_creds)) = &state.auth_credentials else {
        return Ok(next.run(request).await);
    };

    // Check Authorization header (Basic Auth)
    if let Some(auth_header) = request.headers().get(AUTHORIZATION)
        && let Ok(auth_str) = auth_header.to_str()
        && let Some(creds) = auth_str.strip_prefix("Basic ")
        && creds == expected_creds.as_str()
    {
        return Ok(next.run(request).await);
    }

    // Check query parameter as fallback
    if let Some(query_string) = request.uri().query()
        && let Ok(decoded) = urlencoding::decode(query_string)
    {
        for param in decoded.split('&') {
            if let Some((key, value)) = param.split_once('=')
                && key == "auth"
                && value == expected_creds.as_str()
            {
                return Ok(next.run(request).await);
            }
        }
    }

    Ok(axum::http::Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header("WWW-Authenticate", "Basic realm=\"RClone Manager\"")
        .body(axum::body::Body::from("Unauthorized"))
        .unwrap())
}
