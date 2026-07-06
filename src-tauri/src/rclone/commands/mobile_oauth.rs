//! Mobile OAuth flow using `config/oauthstatus` + `config/oauthstop` rc endpoints.
//!
//! This module is only compiled under `#[cfg(feature = "librclone")]`.
//!
//! # Why this exists
//!
//! On desktop, OAuth flows for remotes like Google Drive / Dropbox / OneDrive
//! use a separate `rclone authorize` subprocess that listens on a local port
//! and receives the OAuth callback. That's `ensure_oauth_process` in
//! `commands/system.rs` (desktop-only).
//!
//! On mobile (librclone), we can't spawn subprocesses and don't want to manage
//! TCP ports. Instead, rclone v1.75+ exposes two new rc endpoints:
//!
//! - `config/oauthstatus` — returns `{ "running": bool, "authUrl": string? }`
//! - `config/oauthstop` — stops the in-process OAuth server
//!
//! These work over any transport (HTTP or librclone), so the mobile OAuth flow
//! is:
//!
//! 1. Frontend calls `config/create` or `config/update` (which starts the
//!    in-process OAuth server inside librclone).
//! 2. Backend polls `config/oauthstatus` — when `running: true` + `authUrl`
//!    present, emits an `RCLONE_OAUTH_URL` event to the frontend.
//! 3. Frontend opens `authUrl` in a system browser tab (Android Custom Tabs /
//!    iOS SFSafariViewController via Tauri plugins).
//! 4. The browser redirects to the in-process callback URL, librclone
//!    completes the OAuth flow, and the original `config/create` call returns.
//! 5. If the user cancels, the frontend calls `config/oauthstop`.
//!
//! # Desktop migration
//!
//! Desktop currently uses `ensure_oauth_process` (subprocess). Once rclone
//! v1.75 ships and the bundled rclone is updated, desktop should migrate to
//! this same endpoint-based flow and the subprocess code can be removed.
//! TODO (post-v1.75): remove `ensure_oauth_process` + `cancel_oauth`.

#![cfg(feature = "librclone")]

use std::time::Duration;

use log::{debug, info, warn};
use tauri::{AppHandle, Emitter, Manager};

use crate::utils::rclone::endpoints::config;
use crate::utils::types::{events::RCLONE_OAUTH_URL, state::RcloneState};

const OAUTH_POLL_INTERVAL: Duration = Duration::from_millis(200);

const OAUTH_TIMEOUT: Duration = Duration::from_secs(300);

pub async fn poll_oauth_status(app: AppHandle) {
    let transport = app.state::<RcloneState>().transport.clone();
    let mut url_emitted = false;
    let start = std::time::Instant::now();

    debug!(
        "Starting OAuth status poller (timeout: {:?})",
        OAUTH_TIMEOUT
    );

    loop {
        if start.elapsed() > OAUTH_TIMEOUT {
            warn!("OAuth status poller timed out after {:?}", OAUTH_TIMEOUT);
            return;
        }

        if app.state::<RcloneState>().is_shutting_down() {
            debug!("OAuth status poller exiting — app shutting down");
            return;
        }

        let status = match transport.rpc(config::OAUTHSTATUS, None).await {
            Ok(s) => s,
            Err(e) => {
                debug!("oauthstatus poll error (will retry): {e}");
                tokio::time::sleep(OAUTH_POLL_INTERVAL).await;
                continue;
            }
        };

        let running = status
            .get("running")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let auth_url = status
            .get("authUrl")
            .and_then(|v| v.as_str())
            .map(String::from);

        debug!(
            "oauthstatus: running={running}, authUrl={:?}",
            auth_url.as_deref().map(|u| &u[..u.len().min(60)])
        );

        if let Some(url) = auth_url {
            if !url_emitted {
                info!("OAuth auth URL available, emitting to frontend");
                let _ = app.emit(RCLONE_OAUTH_URL, serde_json::json!({ "url": url }));
                url_emitted = true;
            }
        } else if url_emitted {
            debug!("OAuth server stopped (authUrl is None) after URL was emitted — flow completed");
            return;
        }

        tokio::time::sleep(OAUTH_POLL_INTERVAL).await;
    }
}

#[tauri::command]
pub async fn cancel_oauth(app: AppHandle) -> Result<(), String> {
    let transport = app.state::<RcloneState>().transport.clone();
    info!("Cancelling in-progress OAuth flow");
    transport
        .rpc(config::OAUTHSTOP, None)
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to stop OAuth server: {e}"))
}

pub fn spawn_oauth_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        poll_oauth_status(app).await;
    });
}
