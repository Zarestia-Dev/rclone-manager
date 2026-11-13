//! Centralized module for interacting with the GitHub API and raw content.
//!
//! Re-uses a single `reqwest::Client` for performance (connection pooling)
//! and sets a consistent User-Agent header for all requests.
//!
//! - API calls use `https://api.github.com`
//! - Raw content calls use `https://raw.githubusercontent.com`

use reqwest::header::{ACCEPT, HeaderMap, HeaderValue, USER_AGENT};
use serde::Deserialize;
use std::sync::LazyLock;

pub const OWNER: &str = "Zarestia-Dev";
pub const REPO: &str = "rclone-manager";

/// Fail a connection that stops sending, never one that is merely slow: there is
/// no total deadline, so large downloads finish on slow links.
pub fn detect_stalls(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(120))
}

static GITHUB_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    let mut headers = HeaderMap::new();

    // Set a custom User-Agent for organizational identification
    let user_agent_string = format!("{}/{}/v{}", OWNER, REPO, env!("CARGO_PKG_VERSION"));

    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(&user_agent_string)
            .unwrap_or_else(|_| HeaderValue::from_static("rclone-manager")),
    );

    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github.v3+json"),
    );

    detect_stalls(reqwest::Client::builder())
        .default_headers(headers)
        .build()
        .expect("Failed to build shared reqwest client")
});

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("HTTP request error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("GitHub API rate limit exceeded")]
    RateLimitExceeded,
    #[error("GitHub API error (Status {status}): {body}")]
    ApiError {
        status: reqwest::StatusCode,
        body: String,
    },
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default, rename = "url")]
    pub api_url: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct Release {
    pub tag_name: String,
    pub prerelease: bool,
    pub draft: bool,
    pub assets: Vec<Asset>,
    pub body: Option<String>,
    pub published_at: Option<String>,
    pub html_url: String,
}

async fn parse_response(response: reqwest::Response) -> Result<reqwest::Response, Error> {
    if response.status().is_success() {
        Ok(response)
    } else {
        let status = response.status();
        let is_rate_limit_header = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|v| v.to_str().ok())
            .map(|v| v == "0")
            .unwrap_or(false);

        let body = response.text().await.unwrap_or_default();

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || (status == reqwest::StatusCode::FORBIDDEN
                && (is_rate_limit_header
                    || body.contains("API rate limit exceeded")
                    || body.contains("rate limit")))
        {
            return Err(Error::RateLimitExceeded);
        }

        Err(Error::ApiError { status, body })
    }
}

/// Fetches the 100 most recent releases of a repository (a single page).
pub async fn get_releases(owner: &str, repo: &str) -> Result<Vec<Release>, Error> {
    fetch_releases(&format!(
        "https://api.github.com/repos/{owner}/{repo}/releases?per_page=100"
    ))
    .await
}

/// The last release list per URL with its ETag. Every update check asks for the
/// same list; GitHub answers a matching `If-None-Match` with 304, which neither
/// resends the list nor counts against the rate limit.
static RELEASES: std::sync::Mutex<Vec<(String, String, Vec<Release>)>> =
    std::sync::Mutex::new(Vec::new());

async fn fetch_releases(url: &str) -> Result<Vec<Release>, Error> {
    use reqwest::header::{ETAG, IF_NONE_MATCH};
    let cached_etag = RELEASES.lock().ok().and_then(|cache| {
        cache
            .iter()
            .find(|(cached, _, _)| cached == url)
            .map(|(_, etag, _)| etag.clone())
    });
    let mut request = GITHUB_CLIENT.get(url);
    if let Some(etag) = &cached_etag {
        request = request.header(IF_NONE_MATCH, etag);
    }
    let response = request.send().await?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED
        && let Some(releases) = RELEASES.lock().ok().and_then(|cache| {
            cache
                .iter()
                .find(|(cached, _, _)| cached == url)
                .map(|(_, _, releases)| releases.clone())
        })
    {
        return Ok(releases);
    }
    let response = parse_response(response).await?;
    let etag = response
        .headers()
        .get(ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let releases: Vec<Release> = response.json().await?;
    if let Some(etag) = etag
        && let Ok(mut cache) = RELEASES.lock()
    {
        cache.retain(|(cached, _, _)| cached != url);
        cache.push((url.to_owned(), etag, releases.clone()));
    }
    Ok(releases)
}

/// Fetches the single "latest" release for a repository.
pub async fn get_latest_release(owner: &str, repo: &str) -> Result<Release, Error> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");

    let response = GITHUB_CLIENT.get(&url).send().await?;
    let release: Release = parse_response(response).await?.json().await?;

    Ok(release)
}

/// Fetches a specific release by its tag name.
pub async fn get_release_by_tag(owner: &str, repo: &str, tag: &str) -> Result<Release, Error> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}");

    let response = GITHUB_CLIENT.get(&url).send().await?;
    let release: Release = parse_response(response).await?.json().await?;

    Ok(release)
}

/// Fetches the raw text content of a file from a repo.
pub async fn get_raw_file_content(
    owner: &str,
    repo: &str,
    branch_or_tag: &str,
    path: &str,
) -> Result<String, Error> {
    let url = format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch_or_tag}/{path}");

    let response = GITHUB_CLIENT.get(&url).send().await?;
    let content: String = parse_response(response).await?.text().await?;

    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::Asset;

    #[tokio::test]
    async fn an_unchanged_release_list_is_revalidated_with_its_etag() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/releases", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in [
                "HTTP/1.1 200 OK\r\nETag: \"v1\"\r\nContent-Type: application/json\r\nContent-Length: 83\r\nConnection: close\r\n\r\n[{\"tag_name\":\"v1.2.3\",\"prerelease\":false,\"draft\":false,\"assets\":[],\"html_url\":\"x\"}]",
                "HTTP/1.1 304 Not Modified\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n",
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                let read = socket.read(&mut request).await.unwrap();
                requests.push(String::from_utf8_lossy(&request[..read]).to_lowercase());
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        let first = super::fetch_releases(&url).await.unwrap();
        let second = super::fetch_releases(&url).await.unwrap();
        assert_eq!(first[0].tag_name, "v1.2.3");
        assert_eq!(second[0].tag_name, "v1.2.3");
        let requests = server.await.unwrap();
        assert!(!requests[0].contains("if-none-match"));
        assert!(requests[1].contains("if-none-match: \"v1\""));
    }

    #[test]
    fn assets_retain_api_urls_used_by_tauri_and_accept_legacy_fixtures() {
        let mut input = serde_json::json!({"name":"app.exe", "browser_download_url":"https://github.com/example/app.exe"});
        let legacy: Asset = serde_json::from_value(input.clone()).unwrap();
        assert!(legacy.api_url.is_none());
        input["url"] = "https://api.github.com/repos/example/app/releases/assets/42".into();
        let asset: Asset = serde_json::from_value(input).unwrap();
        assert_eq!(
            asset.api_url.as_deref(),
            Some("https://api.github.com/repos/example/app/releases/assets/42")
        );
    }
}
