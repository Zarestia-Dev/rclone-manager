//! Centralized module for interacting with the GitHub API and raw content.
//!
//! Re-uses a single `reqwest::Client` for performance (connection pooling)
//! and sets a consistent User-Agent header for all requests.
//!
//! - API calls use `https://api.github.com`
//! - Raw content calls use `https://raw.githubusercontent.com`

use once_cell::sync::Lazy;
use reqwest::header::{ACCEPT, HeaderMap, HeaderValue, USER_AGENT};
use serde::Deserialize;

// --- Shared reqwest Client For GitHub API ---
static GITHUB_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    let mut headers = HeaderMap::new();

    // Set a custom User-Agent for organizational identification
    let user_agent_string = format!("Zarestia-Dev/rclone-manager/v{}", env!("CARGO_PKG_VERSION"));

    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(&user_agent_string)
            .unwrap_or_else(|_| HeaderValue::from_static("rclone-manager")),
    );

    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/vnd.github.v3+json"),
    );

    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .expect("Failed to build shared reqwest client")
});

// --- Public Error Type ---
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("HTTP request error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("GitHub API error (Status {status}): {body}")]
    ApiError {
        status: reqwest::StatusCode,
        body: String,
    },
}

// --- Public Data Structures ---
// They are now centralized here.
#[derive(Debug, Deserialize, Clone)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Release {
    pub tag_name: String,
    pub prerelease: bool,
    pub draft: bool,
    pub assets: Vec<Asset>,
    pub body: Option<String>,
    pub published_at: Option<String>,
    pub html_url: String,
}

// --- Internal Helper ---
async fn parse_response(response: reqwest::Response) -> Result<reqwest::Response, Error> {
    if response.status().is_success() {
        Ok(response)
    } else {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(Error::ApiError { status, body })
    }
}

// --- Public API Functions ---

/// Fetches all releases for a given repository.
/// (Used by app/updater.rs)
pub async fn get_releases(owner: &str, repo: &str) -> Result<Vec<Release>, Error> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases?per_page=100");

    let response = GITHUB_CLIENT.get(&url).send().await?;
    let releases: Vec<Release> = parse_response(response).await?.json().await?;

    Ok(releases)
}

/// Fetches the single "latest" release for a repository.
/// (Used by rclone/provision.rs)
pub async fn get_latest_release(owner: &str, repo: &str) -> Result<Release, Error> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");

    let response = GITHUB_CLIENT.get(&url).send().await?;
    let release: Release = parse_response(response).await?.json().await?;

    Ok(release)
}

/// Fetches a specific release by its tag name.
/// (Used by rclone/updater.rs)
pub async fn get_release_by_tag(owner: &str, repo: &str, tag: &str) -> Result<Release, Error> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}");

    let response = GITHUB_CLIENT.get(&url).send().await?;
    let release: Release = parse_response(response).await?.json().await?;

    Ok(release)
}

/// Fetches the raw text content of a file from a repo.
/// (Used by rclone/updater.rs for changelog.md)
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
