//! Centralized module for interacting with the GitHub API.
//!
//! Re-uses a single reqwest::Client for performance (connection pooling)
//! and sets a consistent User-Agent header for all requests.

use once_cell::sync::Lazy;
use reqwest::header::{ACCEPT, USER_AGENT};
use serde::Deserialize;

// --- Shared reqwest Client For GitHub API ---
static GITHUB_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    // Set a custom User-Agent for organizational identification
    let user_agent_string = format!("Zarestia-Dev/rclone-manager/v{}", env!("CARGO_PKG_VERSION"));
    reqwest::Client::builder()
        .default_headers(
            [
                (USER_AGENT, user_agent_string.parse().unwrap()),
                (ACCEPT, "application/vnd.github.v3+json".parse().unwrap()),
            ]
            .iter()
            .cloned()
            .collect(),
        )
        .build()
        .expect("Failed to build shared reqwest client")
});

// --- Public Error Type ---
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("HTTP request error: {0}")]
    Http(#[from] reqwest::Error),
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

// --- Public API Functions ---

/// Fetches all releases for a given repository.
/// (Used by app/updater.rs)
pub async fn get_releases(owner: &str, repo: &str) -> Result<Vec<Release>, Error> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases?per_page=100",
        owner, repo
    );

    let releases: Vec<Release> = GITHUB_CLIENT
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    Ok(releases)
}

/// Fetches the single "latest" release for a repository.
/// (Used by rclone/provision.rs)
pub async fn get_latest_release(owner: &str, repo: &str) -> Result<Release, Error> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        owner, repo
    );

    let release: Release = GITHUB_CLIENT
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    Ok(release)
}

/// Fetches a specific release by its tag name.
/// (Used by rclone/updater.rs)
pub async fn get_release_by_tag(owner: &str, repo: &str, tag: &str) -> Result<Release, Error> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/releases/tags/{}",
        owner, repo, tag
    );

    let release: Release = GITHUB_CLIENT
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

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
    let url = format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        owner, repo, branch_or_tag, path
    );

    let content: String = GITHUB_CLIENT
        .get(&url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;

    Ok(content)
}
