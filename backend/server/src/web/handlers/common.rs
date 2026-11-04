use crate::utils::io::http_helpers::{classify_error_status, has_parent_path_component};
use crate::web::state::{ApiResponse, AppError};
use axum::{Json, http::StatusCode};

#[cfg(debug_assertions)]
pub async fn root_handler() -> &'static str {
    "RClone Manager Headless API Server"
}

pub async fn health_handler() -> Json<ApiResponse<String>> {
    Json(ApiResponse::success("OK".to_string()))
}

/// Media routes answer to `<audio>`, `<img>` and download links, never to UI text,
/// so their messages stay plain; `classify_error_status` matches on them.
pub(super) fn reject_parent_components(path: &str) -> Result<(), AppError> {
    if has_parent_path_component(path) {
        return Err(AppError::Forbidden("Path traversal denied".into()));
    }
    Ok(())
}

/// Maps a transport or filesystem error to the status its message implies.
pub(super) fn classify_failure(message: String) -> AppError {
    match classify_error_status(&message) {
        StatusCode::NOT_FOUND => AppError::NotFound(message),
        StatusCode::FORBIDDEN => AppError::Forbidden(message),
        StatusCode::LOCKED => AppError::Locked(message),
        _ => AppError::Internal(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_keep_the_status_their_message_implies() {
        for (message, status) in [
            ("object not found", StatusCode::NOT_FOUND),
            ("permission denied", StatusCode::FORBIDDEN),
            ("file is locked", StatusCode::LOCKED),
            ("boom", StatusCode::INTERNAL_SERVER_ERROR),
        ] {
            use axum::response::IntoResponse;
            assert_eq!(
                classify_failure(message.into()).into_response().status(),
                status,
                "{message}"
            );
        }
    }

    #[test]
    fn parent_components_are_forbidden_but_dotted_names_are_not() {
        assert!(reject_parent_components("a/../b").is_err());
        assert!(reject_parent_components("a/b..c").is_ok());
    }
}
