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
