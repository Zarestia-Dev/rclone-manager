use axum::{
    extract::State,
    http::{
        StatusCode,
        header::{AUTHORIZATION, COOKIE, SET_COOKIE},
    },
    middleware::Next,
    response::{IntoResponse, Json},
};
use log::error;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Arc};
use tauri::AppHandle;
use tokio::sync::{RwLock, broadcast};

pub type SessionStore = Arc<RwLock<HashSet<String>>>;

/// Shared state for web server handlers
#[derive(Clone)]
pub struct WebServerState {
    pub app_handle: AppHandle,
    pub event_tx: Arc<broadcast::Sender<TauriEvent>>,
    pub auth_credentials: Option<(String, String)>,
    pub sessions: SessionStore,
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

impl<E: Into<anyhow::Error>> From<E> for AppError {
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

pub async fn create_session_handler(State(state): State<WebServerState>) -> impl IntoResponse {
    let token = uuid::Uuid::new_v4().simple().to_string();
    state.sessions.write().await.insert(token.clone());

    let cookie = format!("session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400");

    ([(SET_COOKIE, cookie)], Json(ApiResponse::<()>::success(())))
}

/// Deletes the session cookie, effectively logging the user out.
pub async fn delete_session_handler(
    State(state): State<WebServerState>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    if let Some(token) = extract_session_cookie(&headers) {
        state.sessions.write().await.remove(token);
    }

    let expire = "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0";
    ([(SET_COOKIE, expire)], Json(ApiResponse::<()>::success(())))
}

pub async fn auth_middleware(
    State(state): State<WebServerState>,
    request: axum::http::Request<axum::body::Body>,
    next: Next,
) -> Result<axum::response::Response, StatusCode> {
    let Some((_, expected_creds)) = &state.auth_credentials else {
        return Ok(next.run(request).await);
    };

    if let Some(auth_header) = request.headers().get(AUTHORIZATION)
        && let Ok(auth_str) = auth_header.to_str()
        && let Some(creds) = auth_str.strip_prefix("Basic ")
        && creds == expected_creds.as_str()
    {
        return Ok(next.run(request).await);
    }

    if let Some(token) = extract_session_cookie(request.headers())
        && state.sessions.read().await.contains(token)
    {
        return Ok(next.run(request).await);
    }

    Ok(axum::http::Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header("WWW-Authenticate", "Basic realm=\"RClone Manager\"")
        .body(axum::body::Body::from("Unauthorized"))
        .unwrap())
}

fn extract_session_cookie(headers: &axum::http::HeaderMap) -> Option<&str> {
    let cookie_str = headers.get(COOKIE)?.to_str().ok()?;
    cookie_str
        .split(';')
        .find_map(|part| part.trim().strip_prefix("session="))
}
