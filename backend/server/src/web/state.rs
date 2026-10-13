use axum::{
    http::StatusCode,
    response::{IntoResponse, Json},
};
use log::error;
use rclone_manager_core::context::AppHandle;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, sync::Arc};
use tokio::sync::RwLock;

use crate::services::bridge::EventBridge;

pub type SessionStore = Arc<RwLock<HashSet<String>>>;

/// Shared state for web server handlers
#[derive(Clone)]
pub struct WebServerState {
    pub app_handle: AppHandle,
    pub event_bridge: Arc<EventBridge>,
    pub auth_credentials: Option<(String, String)>,
    pub sessions: SessionStore,
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
