use log::debug;
use std::path::Path;
use std::time::Instant;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::utils::types::provision::{
    ProvisionComponent, ProvisionProgressPayload, ProvisionStage, ProvisionState,
};

pub async fn stream_download_to_file(
    app_handle: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest_path: &Path,
    component: ProvisionComponent,
    cancel_token: Option<CancellationToken>,
) -> Result<(), String> {
    debug!("Downloading {url} to {:?}", dest_path);

    let provision_state = app_handle.state::<ProvisionState>();

    let resp = if let Some(ref token) = cancel_token {
        tokio::select! {
            () = token.cancelled() => {
                provision_state.set_stage(
                    app_handle,
                    component.clone(),
                    ProvisionStage::Cancelled,
                    0,
                    None,
                );
                return Err(crate::localized_error!("backendErrors.rclone.downloadCancelled"));
            }
            res = client.get(url).send() => {
                match res {
                    Ok(r) => r,
                    Err(e) => {
                        let err = crate::localized_error!("backendErrors.request.failed", "error" => e);
                        provision_state.set_stage(
                            app_handle,
                            component,
                            ProvisionStage::Error,
                            0,
                            Some(err.clone()),
                        );
                        return Err(err);
                    }
                }
            }
        }
    } else {
        match client.get(url).send().await {
            Ok(r) => r,
            Err(e) => {
                let err = crate::localized_error!("backendErrors.request.failed", "error" => e);
                provision_state.set_stage(
                    app_handle,
                    component,
                    ProvisionStage::Error,
                    0,
                    Some(err.clone()),
                );
                return Err(err);
            }
        }
    };

    if !resp.status().is_success() {
        let err = crate::localized_error!(
            "backendErrors.rclone.downloadFailed",
            "error" => format!("HTTP {}", resp.status())
        );
        provision_state.set_stage(
            app_handle,
            component,
            ProvisionStage::Error,
            0,
            Some(err.clone()),
        );
        return Err(err);
    }

    let total_bytes = resp.content_length();
    let mut downloaded_bytes: u64 = 0;
    let mut last_emit = Instant::now();

    // Initial 0% progress emission
    provision_state.update_progress(
        app_handle,
        ProvisionProgressPayload {
            component: component.clone(),
            stage: ProvisionStage::Downloading,
            downloaded_bytes: 0,
            total_bytes,
            error: None,
        },
    );

    let mut file = tokio::fs::File::create(dest_path)
        .await
        .map_err(|e| format!("Failed to create destination file: {e}"))?;

    let mut response = resp;
    loop {
        let chunk_res = if let Some(ref token) = cancel_token {
            tokio::select! {
                () = token.cancelled() => {
                    drop(file);
                    let _ = tokio::fs::remove_file(dest_path).await;
                    provision_state.set_stage(
                        app_handle,
                        component.clone(),
                        ProvisionStage::Cancelled,
                        downloaded_bytes,
                        None,
                    );
                    return Err(crate::localized_error!("backendErrors.rclone.downloadCancelled"));
                }
                res = response.chunk() => res,
            }
        } else {
            response.chunk().await
        };

        let chunk = match chunk_res {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                drop(file);
                let _ = tokio::fs::remove_file(dest_path).await;
                let err = crate::localized_error!("backendErrors.request.failed", "error" => e);
                provision_state.set_stage(
                    app_handle,
                    component,
                    ProvisionStage::Error,
                    downloaded_bytes,
                    Some(err.clone()),
                );
                return Err(err);
            }
        };

        if let Err(e) = file.write_all(&chunk).await {
            drop(file);
            let _ = tokio::fs::remove_file(dest_path).await;
            let err = format!("Failed to write chunk: {e}");
            provision_state.set_stage(
                app_handle,
                component,
                ProvisionStage::Error,
                downloaded_bytes,
                Some(err.clone()),
            );
            return Err(err);
        }
        downloaded_bytes += chunk.len() as u64;

        let now = Instant::now();
        if now.duration_since(last_emit).as_millis() >= 150 {
            provision_state.update_progress(
                app_handle,
                ProvisionProgressPayload {
                    component: component.clone(),
                    stage: ProvisionStage::Downloading,
                    downloaded_bytes,
                    total_bytes,
                    error: None,
                },
            );
            last_emit = now;
        }
    }

    if let Err(e) = file.flush().await {
        drop(file);
        let _ = tokio::fs::remove_file(dest_path).await;
        let err = format!("Failed to flush destination file: {e}");
        provision_state.set_stage(
            app_handle,
            component,
            ProvisionStage::Error,
            downloaded_bytes,
            Some(err.clone()),
        );
        return Err(err);
    }

    // Final download complete emission for stage
    provision_state.update_progress(
        app_handle,
        ProvisionProgressPayload {
            component,
            stage: ProvisionStage::Downloading,
            downloaded_bytes,
            total_bytes,
            error: None,
        },
    );

    Ok(())
}
