//! HTTP authentication middleware and session cookie handlers.
use super::state::{ApiResponse, WebServerState};
use axum::{
    extract::State,
    http::{
        StatusCode,
        header::{AUTHORIZATION, COOKIE, SET_COOKIE},
    },
    middleware::Next,
    response::{IntoResponse, Json},
};

const SESSION_TTL: std::time::Duration = std::time::Duration::from_secs(86400);

pub async fn create_session_handler(
    State(state): State<WebServerState>,
    headers: axum::http::HeaderMap,
) -> impl IntoResponse {
    let now = std::time::Instant::now();
    let mut sessions = state.sessions.write().await;
    sessions.retain(|_, expires| *expires > now);
    if let Some(previous) = extract_session_cookie(&headers) {
        sessions.remove(previous);
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    sessions.insert(token.clone(), now + SESSION_TTL);

    let cookie = format!(
        "session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
        SESSION_TTL.as_secs()
    );

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

    if let Some(token) = extract_session_cookie(request.headers()) {
        let valid = {
            let now = std::time::Instant::now();
            state
                .sessions
                .read()
                .await
                .get(token)
                .is_some_and(|expires| *expires > now)
        };
        if valid {
            return Ok(next.run(request).await);
        }
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
