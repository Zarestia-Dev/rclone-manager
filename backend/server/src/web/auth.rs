//! HTTP authentication middleware and session cookie handlers.
use super::state::{ApiResponse, WebServerState};
use axum::{
    extract::State,
    http::{
        HeaderMap, StatusCode,
        header::{AUTHORIZATION, COOKIE, SET_COOKIE, WWW_AUTHENTICATE},
    },
    middleware::Next,
    response::{IntoResponse, Json, Response},
};

const SESSION_TTL: std::time::Duration = std::time::Duration::from_secs(86400);

/// How soon a long-lived response notices that its session ended.
pub(super) const SESSION_RECHECK: std::time::Duration = std::time::Duration::from_secs(5);

/// Attached to requests authenticated by a session cookie, so long-lived
/// responses can stop when the session ends.
#[derive(Clone)]
pub(super) struct SessionToken(pub String);

pub async fn create_session_handler(
    State(state): State<WebServerState>,
    headers: HeaderMap,
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
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Some(token) = extract_session_cookie(&headers) {
        state.sessions.write().await.remove(token);
    }

    let expire = session_cookie("", 0, is_secure(&state, &headers));
    ([(SET_COOKIE, expire)], Json(ApiResponse::<()>::success(())))
}

pub(super) async fn session_is_valid(state: &WebServerState, token: &str) -> bool {
    let now = std::time::Instant::now();
    state
        .sessions
        .read()
        .await
        .get(token)
        .is_some_and(|expires| *expires > now)
}

/// Completes once the session behind a request is logged out or expired. Requests
/// that were not authenticated by a session (Basic credentials, or no
/// authentication) have nothing to revoke, so it never completes for them.
pub(super) async fn session_ended(
    state: WebServerState,
    session: Option<SessionToken>,
    recheck_every: std::time::Duration,
) {
    let Some(SessionToken(token)) = session else {
        return std::future::pending().await;
    };
    loop {
        tokio::time::sleep(recheck_every).await;
        if !session_is_valid(&state, &token).await {
            return;
        }
    }
}

pub async fn auth_middleware(
    State(state): State<WebServerState>,
    mut request: axum::extract::Request,
    next: Next,
) -> Response {
    let Some(expected) = &state.basic_auth else {
        return next.run(request).await;
    };

    let presented = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Basic "));
    if presented.is_some_and(|creds| constant_time_eq(creds.as_bytes(), expected.as_bytes())) {
        return next.run(request).await;
    }
    let wrong_password = presented.is_some();

    if let Some(token) = extract_session_cookie(request.headers()).map(str::to_owned)
        && session_is_valid(&state, &token).await
    {
        request.extensions_mut().insert(SessionToken(token));
        return next.run(request).await;
    }

    if wrong_password {
        tokio::time::sleep(state.failed_logins.record()).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        [(WWW_AUTHENTICATE, "Basic realm=\"RClone Manager\"")],
        "Unauthorized",
    )
        .into_response()
}

/// Browsers drop `Secure` cookies on plain HTTP, so only set it when the
/// connection is HTTPS: terminated here, or by a proxy that says so.
fn is_secure(state: &WebServerState, headers: &HeaderMap) -> bool {
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

pub(super) fn extract_session_cookie(headers: &HeaderMap) -> Option<&str> {
    let cookie_str = headers.get(COOKIE)?.to_str().ok()?;
    cookie_str
        .split(';')
        .find_map(|part| part.trim().strip_prefix("session="))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Extension, Router, body::Body, http::Request, middleware::from_fn_with_state, routing::get,
    };
    use rclone_manager_core::{context::AppHandle, services::bridge::EventBridge};
    use std::{sync::Arc, time::Duration};
    use tower::ServiceExt;

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

    fn protected(state: WebServerState) -> Router {
        Router::new()
            .route(
                "/",
                get(|token: Option<Extension<SessionToken>>| async move {
                    token.map_or_else(|| "basic".to_owned(), |Extension(token)| token.0)
                }),
            )
            .layer(from_fn_with_state(state, auth_middleware))
    }

    async fn call(router: Router, header: Option<(&str, &str)>) -> (StatusCode, String) {
        let mut request = Request::builder().uri("/");
        if let Some((name, value)) = header {
            request = request.header(name, value);
        }
        let response = router
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn basic_credentials_and_live_sessions_pass_and_everything_else_is_rejected() {
        let state = WebServerState::new(
            AppHandle::default(),
            Arc::new(EventBridge::new(1, None)),
            Some("dXNlcjpwYXNz".into()),
            false,
        );
        let now = std::time::Instant::now();
        state.sessions.write().await.extend([
            ("live".to_owned(), now + Duration::from_secs(60)),
            ("expired".to_owned(), now - Duration::from_secs(1)),
        ]);
        let router = protected(state);

        assert_eq!(
            call(
                router.clone(),
                Some(("authorization", "Basic dXNlcjpwYXNz"))
            )
            .await,
            (StatusCode::OK, "basic".into())
        );
        assert_eq!(
            call(router.clone(), Some(("cookie", "a=b; session=live"))).await,
            (StatusCode::OK, "live".into())
        );
        for header in [
            None,
            Some(("cookie", "session=expired")),
            Some(("cookie", "session=unknown")),
            Some(("authorization", "Basic wrong")),
        ] {
            let response = call(router.clone(), header).await;
            assert_eq!(response, (StatusCode::UNAUTHORIZED, "Unauthorized".into()));
        }
    }
}
