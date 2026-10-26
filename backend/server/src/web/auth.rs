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

    let cookie = session_cookie(&token, SESSION_TTL.as_secs(), is_secure(&state, &headers));

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

    let expire = session_cookie("", 0, is_secure(&state, &headers));
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
        && constant_time_eq(creds.as_bytes(), expected_creds.as_bytes())
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

/// Browsers drop `Secure` cookies on plain HTTP, so only set it when the
/// connection is HTTPS: terminated here, or by a proxy that says so.
fn is_secure(state: &WebServerState, headers: &axum::http::HeaderMap) -> bool {
    state.tls
        || headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .is_some_and(|proto| proto.trim().eq_ignore_ascii_case("https"))
}

fn session_cookie(token: &str, max_age: u64, secure: bool) -> String {
    let secure = if secure { "; Secure" } else { "" };
    format!("session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{secure}")
}

/// Compares secrets without leaking the position of the first mismatch.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

fn extract_session_cookie(headers: &axum::http::HeaderMap) -> Option<&str> {
    let cookie_str = headers.get(COOKIE)?.to_str().ok()?;
    cookie_str
        .split(';')
        .find_map(|part| part.trim().strip_prefix("session="))
}

#[cfg(test)]
mod tests {
    use super::{constant_time_eq, session_cookie};

    #[test]
    fn cookie_is_secure_only_over_https() {
        assert!(session_cookie("t", 60, true).ends_with("; Secure"));
        assert!(!session_cookie("t", 60, false).contains("Secure"));
        assert_eq!(
            session_cookie("", 0, false),
            "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
        );
    }

    #[test]
    fn compares_whole_secret() {
        assert!(constant_time_eq(b"dXNlcjpwYXNz", b"dXNlcjpwYXNz"));
        assert!(!constant_time_eq(b"dXNlcjpwYXNz", b"dXNlcjpwYXNa"));
        assert!(!constant_time_eq(b"dXNlcjpwYXNz", b"dXNlcjpwYXN"));
        assert!(!constant_time_eq(b"", b"x"));
    }
}
