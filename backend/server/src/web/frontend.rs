//! Frontend assets compiled into standalone release binaries.
use super::routes::is_client_route;
use axum::{
    Router,
    body::Body,
    http::{HeaderMap, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::get,
};
use tower_http::compression::CompressionLayer;

include!(concat!(env!("OUT_DIR"), "/frontend.rs"));

pub(super) fn router() -> Router {
    Router::new()
        .fallback(get(serve))
        .layer(CompressionLayer::new())
}

fn asset(path: &str) -> Option<(&'static [u8], u64)> {
    ASSETS
        .binary_search_by_key(&path, |(name, ..)| *name)
        .ok()
        .map(|index| (ASSETS[index].1, ASSETS[index].2))
}

/// Angular names bundles `<name>-<8 character hash>.<ext>` at the top level;
/// their content never changes under that name.
fn is_fingerprinted(name: &str) -> bool {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    let hash = stem.as_bytes().last_chunk::<8>();
    !name.contains('/')
        && matches!(extension, "js" | "mjs" | "css" | "woff" | "woff2")
        && stem.len() > 9
        && stem.as_bytes()[stem.len() - 9] == b'-'
        && hash.is_some_and(|hash| {
            hash.iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
}

fn matches_etag(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|candidate| {
                let candidate = candidate.trim().trim_start_matches("W/");
                candidate == "*" || candidate == etag
            })
        })
}

async fn serve(uri: Uri, headers: HeaderMap) -> Response {
    let Ok(decoded) = percent_encoding::percent_decode_str(uri.path()).decode_utf8() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let path = decoded.trim_start_matches('/');
    let (name, (bytes, fingerprint)) = match asset(path) {
        Some(found) => (path, found),
        None if is_client_route(path) => (
            "index.html",
            asset("index.html").expect("Build requires index.html"),
        ),
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let etag = format!("\"{fingerprint:016x}\"");
    let cache_control = if is_fingerprinted(name) {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    if matches_etag(&headers, &etag) {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, etag),
                (header::CACHE_CONTROL, cache_control.to_owned()),
            ],
        )
            .into_response();
    }
    let mime = mime_guess::from_path(name).first_or_octet_stream();
    (
        [
            (header::CONTENT_TYPE, mime.as_ref().to_owned()),
            (header::CACHE_CONTROL, cache_control.to_owned()),
            (header::ETAG, etag),
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

    #[test]
    fn only_hashed_top_level_bundles_are_fingerprinted() {
        for name in [
            "main-ABCD1234.js",
            "chunk-BdK-jUxY.js",
            "chunk-B_2XJbjq.js",
            "styles-9aZ_x-Qw.css",
        ] {
            assert!(is_fingerprinted(name), "{name}");
        }
        for name in [
            "index.html",
            "main.js",
            "chunk-short.js",
            "chunk-ABCD1234.js.map",
            "assets/icons/icon-ABCD1234.js",
            "i18n/en-US/main.json",
            "chunk-ABCD123!.js",
            "-ABCD1234.js",
        ] {
            assert!(!is_fingerprinted(name), "{name}");
        }
    }

    #[test]
    fn etag_matching_accepts_lists_weak_validators_and_wildcards() {
        let headers = |value: &str| {
            let mut map = HeaderMap::new();
            map.insert(header::IF_NONE_MATCH, value.parse().unwrap());
            map
        };
        assert!(matches_etag(&headers("\"abc\""), "\"abc\""));
        assert!(matches_etag(&headers("\"x\", W/\"abc\""), "\"abc\""));
        assert!(matches_etag(&headers("*"), "\"abc\""));
        assert!(!matches_etag(&headers("\"abd\""), "\"abc\""));
        assert!(!matches_etag(&HeaderMap::new(), "\"abc\""));
    }

    #[tokio::test]
    async fn serves_index_and_client_routes() {
        for path in ["/", "/index.html", "/settings?tab=general"] {
            let response = router()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
            assert_eq!(
                to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .as_ref(),
                asset("index.html").unwrap().0
            );
        }
    }

    #[tokio::test]
    async fn serves_assets_with_mime_and_supports_head() {
        let (name, bytes, _) = ASSETS
            .iter()
            .find(|(name, ..)| name.ends_with(".js"))
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
    async fn bundles_are_immutable_and_revalidation_costs_no_body() {
        let name = ASSETS
            .iter()
            .map(|(name, ..)| *name)
            .find(|name| is_fingerprinted(name))
            .expect("hashed Angular bundle");
        let request = |etag: Option<&str>| {
            let mut request = Request::builder().uri(format!("/{name}"));
            if let Some(etag) = etag {
                request = request.header(header::IF_NONE_MATCH, etag);
            }
            request.body(Body::empty()).unwrap()
        };
        let response = router().oneshot(request(None)).await.unwrap();
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        let etag = response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_owned();

        let response = router().oneshot(request(Some(&etag))).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .is_empty()
        );
        let response = router().oneshot(request(Some("\"stale\""))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn clients_that_accept_gzip_receive_smaller_text_assets() {
        let (name, bytes, _) = ASSETS
            .iter()
            .find(|(name, bytes, _)| name.ends_with(".js") && bytes.len() > 4096)
            .expect("sizeable Angular JS bundle");
        let response = router()
            .oneshot(
                Request::builder()
                    .uri(format!("/{name}"))
                    .header(header::ACCEPT_ENCODING, "gzip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CONTENT_ENCODING], "gzip");
        assert!(
            to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
                .len()
                < bytes.len()
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
