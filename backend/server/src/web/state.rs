use axum::{
    http::StatusCode,
    response::{IntoResponse, Json},
};
use log::error;
use rclone_manager_core::context::AppHandle;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fmt::Display,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};
use tokio::sync::RwLock;

use crate::services::bridge::EventBridge;

pub type SessionStore = Arc<RwLock<HashMap<String, Instant>>>;

/// Shared state for web server handlers
#[derive(Clone)]
pub struct WebServerState {
    pub app_handle: AppHandle,
    pub event_bridge: Arc<EventBridge>,
    /// Base64 `user:password`, as a Basic `Authorization` header carries it.
    pub basic_auth: Option<String>,
    pub sessions: SessionStore,
    pub failed_logins: Arc<FailedLogins>,
    /// The listener terminates TLS itself, so session cookies can be `Secure`.
    pub tls: bool,
}

impl WebServerState {
    pub fn new(
        app_handle: AppHandle,
        event_bridge: Arc<EventBridge>,
        basic_auth: Option<String>,
        tls: bool,
    ) -> Self {
        Self {
            app_handle,
            event_bridge,
            basic_auth,
            sessions: SessionStore::default(),
            failed_logins: Arc::default(),
            tls,
        }
    }
}

/// Slows down repeated wrong passwords. The right password is never delayed, so
/// an attacker cannot lock the owner out.
#[derive(Default)]
pub struct FailedLogins(Mutex<(Option<Instant>, u32)>);

impl FailedLogins {
    const WINDOW: Duration = Duration::from_secs(60);
    const FREE_ATTEMPTS: u32 = 5;
    const STEP: Duration = Duration::from_millis(250);
    const MAX_STEPS: u32 = 12;

    /// Records a failure and returns how long to hold back the rejection.
    pub fn record(&self) -> Duration {
        let mut guard = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        let (window_start, failures) = &mut *guard;
        if window_start.is_none_or(|start| now.duration_since(start) > Self::WINDOW) {
            *window_start = Some(now);
            *failures = 0;
        }
        *failures = failures.saturating_add(1);
        Self::STEP
            * failures
                .saturating_sub(Self::FREE_ATTEMPTS)
                .min(Self::MAX_STEPS)
    }
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
    BadRequest(String),
    Forbidden(String),
    NotFound(String),
    Locked(String),
    Internal(String),
}

impl AppError {
    pub fn internal(error: impl Display) -> Self {
        Self::Internal(error.to_string())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match self {
            AppError::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            AppError::Forbidden(message) => (StatusCode::FORBIDDEN, message),
            AppError::NotFound(message) => (StatusCode::NOT_FOUND, message),
            AppError::Locked(message) => (StatusCode::LOCKED, message),
            AppError::Internal(message) => {
                error!("API Error: {message}");
                (StatusCode::INTERNAL_SERVER_ERROR, message)
            }
        };
        (status, Json(ApiResponse::<()>::error(message))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_keep_their_http_status() {
        for (error, status) in [
            (AppError::BadRequest("a".into()), StatusCode::BAD_REQUEST),
            (AppError::Forbidden("a".into()), StatusCode::FORBIDDEN),
            (AppError::NotFound("a".into()), StatusCode::NOT_FOUND),
            (AppError::Locked("a".into()), StatusCode::LOCKED),
            (AppError::internal("a"), StatusCode::INTERNAL_SERVER_ERROR),
        ] {
            assert_eq!(error.into_response().status(), status);
        }
    }

    #[test]
    fn wrong_passwords_are_delayed_progressively_up_to_a_cap() {
        let failures = FailedLogins::default();
        for _ in 0..FailedLogins::FREE_ATTEMPTS {
            assert_eq!(failures.record(), Duration::ZERO);
        }
        let first = failures.record();
        let second = failures.record();
        assert_eq!(first, FailedLogins::STEP);
        assert!(second > first);
        for _ in 0..100 {
            failures.record();
        }
        assert_eq!(
            failures.record(),
            FailedLogins::STEP * FailedLogins::MAX_STEPS
        );
    }
}
