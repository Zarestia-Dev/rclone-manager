//! Frontend assets compiled into standalone release binaries.
use axum::{
    Router,
    body::Body,
    http::{StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};

include!(concat!(env!("OUT_DIR"), "/frontend.rs"));

pub(super) fn router() -> Router {
    Router::new().fallback(get(serve))
}

fn asset(path: &str) -> Option<&'static [u8]> {
    ASSETS
        .binary_search_by_key(&path, |(name, _)| *name)
        .ok()
        .map(|index| ASSETS[index].1)
}

async fn serve(uri: Uri) -> Response {
    let Ok(decoded) = percent_encoding::percent_decode_str(uri.path()).decode_utf8() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let path = decoded.trim_start_matches('/');
    if path.split('/').any(|part| part == ".." || part == ".")
        || path.contains(['\\', '\0'])
        || path == "api"
        || path.starts_with("api/")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let (name, bytes) = match asset(path) {
        Some(bytes) => (path, bytes),
        None if super::routes::is_client_route(path) => (
            "index.html",
            asset("index.html").expect("Build requires index.html"),
        ),
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    (
        [
            (header::CONTENT_TYPE, mime.as_ref().to_owned()),
            (header::CACHE_CONTROL, "no-cache".to_owned()),
        ],
        Body::from(bytes),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn serves_index_and_client_routes() {
        for path in ["/", "/index.html", "/settings?tab=general"] {
            let response = router()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html");
            assert_eq!(
                to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .as_ref(),
                asset("index.html").unwrap()
            );
        }
    }

    #[tokio::test]
    async fn serves_assets_with_mime_and_supports_head() {
        let (name, bytes) = ASSETS
            .iter()
            .find(|(name, _)| name.ends_with(".js"))
            .expect("Angular JS bundle");
        let response = router()
            .oneshot(
                Request::builder()
                    .uri(format!("/{name}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            mime_guess::from_path(name).first_or_octet_stream().as_ref()
        );
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .as_ref(),
            *bytes
        );
        let response = router()
            .oneshot(
                Request::builder()
                    .method("HEAD")
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn rejects_missing_assets_traversal_and_non_get_requests() {
        for path in [
            "/missing.js",
            "/assets/missing",
            "/api/missing",
            "/%2e%2e/index.html",
            "/foo%5cbar",
            "/%00",
        ] {
            let response = router()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
        let response = router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
}
