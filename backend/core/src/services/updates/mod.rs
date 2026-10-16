#[cfg(all(feature = "updater", target_os = "android"))]
mod android;
#[cfg(feature = "updater")]
pub mod binary;
#[cfg(feature = "updater")]
pub mod health;
#[cfg(feature = "updater")]
pub mod install;
pub mod policy;
#[cfg(feature = "updater")]
mod process_tree;
#[cfg(feature = "updater")]
mod signed;
#[cfg(feature = "updater")]
mod supervisor;

use crate::context::AppHandle;
use crate::services::settings::AppSettingsManager;
use crate::utils::github_client::{OWNER, REPO};
use crate::utils::types::{
    events::{APP_EVENT, UPDATER_STATE_CHANGED, UpdaterStateChanged},
    updater::{AppUpdaterState, Result, UpdateInfo, UpdateMetadata, UpdateState},
};
use crate::utils::{
    app::notification::{NotificationEvent, UpdateStage, notify},
    github_client,
};
use log::info;

pub(crate) fn emit_state_changed() {
    crate::services::bridge::emit(UPDATER_STATE_CHANGED, UpdaterStateChanged::App);
}

pub use crate::utils::version::{clean_app_version, is_version_newer};

pub async fn fetch_update(app: AppHandle, channel: String) -> Result<Option<UpdateInfo>> {
    let updater_state = app.state::<AppUpdaterState>();
    let result = fetch_update_inner(&app, &channel, &updater_state).await;
    if result.is_err() {
        let mut data = updater_state.data.lock();
        if data.state == UpdateState::Checking {
            data.state = UpdateState::Idle;
        }
    }
    emit_state_changed();
    result
}

async fn fetch_update_inner(
    app: &AppHandle,
    channel: &str,
    updater_state: &AppUpdaterState,
) -> Result<Option<UpdateInfo>> {
    #[cfg(feature = "updater")]
    let _operation = updater_state.operation.lock().await;
    let installation = policy::get_update_policy(app.clone()).await;
    {
        let mut data = updater_state.data.lock();
        if matches!(
            data.state,
            UpdateState::Downloading
                | UpdateState::ReadyToRestart
                | UpdateState::Installing
                | UpdateState::Checking
        ) {
            return Ok(data.info());
        }

        data.state = UpdateState::Checking;
        data.downloaded_bytes = 0;
        data.total_bytes = 0;
        data.failure_message = None;
        data.last_metadata = None;
        data.downloaded_payload = None;
        #[cfg(feature = "updater")]
        {
            data.pending_action = None;
        }
    }

    info!("Checking for app updates on channel: {channel}");

    let releases = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        github_client::get_releases(OWNER, REPO),
    )
    .await
    .map_err(|error| {
        crate::utils::types::updater::UpdaterError::UpdateUnavailable(error.to_string())
    })??;
    let Some(release) = releases
        .into_iter()
        .filter(|r| !r.draft)
        .find(|r| is_release_for_channel(r, channel, app.product().release_prefix))
    else {
        info!("No suitable release found for channel: {channel}");
        updater_state.data.lock().state = UpdateState::Idle;
        return Ok(None);
    };

    let current_version_str = env!("CARGO_PKG_VERSION").to_string();
    let release_version_str = clean_app_version(&release.tag_name);

    let is_newer = is_version_newer(&current_version_str, release_version_str);
    if !is_newer {
        info!("App is up to date (current: {current_version_str}, latest: {release_version_str})");
        updater_state.data.lock().state = UpdateState::Idle;
        return Ok(None);
    }

    info!("Newer version found: {release_version_str} (current: {current_version_str})");

    let update_metadata = UpdateMetadata {
        version: release_version_str.to_string(),
        current_version: current_version_str,
        release_tag: Some(release.tag_name.clone()),
        release_notes: release.body.clone(),
        release_date: release.published_at.clone(),
        release_url: Some(release.html_url.clone()),
        update_available: true,
        channel: Some(channel.to_string()),
    };

    #[cfg(feature = "updater")]
    let (pending_action, update_metadata, installation) = {
        let mut installation = installation;
        let mut meta = update_metadata;
        let action = if installation.can_install {
            let result = tokio::time::timeout(std::time::Duration::from_secs(45), async {
                match installation.method {
                    policy::UpdateMethod::Tauri => {
                        app.host().check_update(&release, &mut meta).await
                    }
                    policy::UpdateMethod::Binary | policy::UpdateMethod::Android => {
                        signed::check(app, &release, &installation).await
                    }
                    policy::UpdateMethod::Unavailable => Ok(None),
                }
            })
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
            match result {
                Ok(Some(action)) => Some(action),
                Ok(None) => {
                    installation.can_install = false;
                    installation.reason = Some(crate::localized_error!(
                        "backendErrors.updater.missingArtifact"
                    ));
                    None
                }
                Err(error) => {
                    log::warn!("Update installation preparation failed: {error}");
                    installation.can_install = false;
                    installation.reason = Some(
                        crate::localized_error!("backendErrors.updater.updateUnavailable", "error" => error),
                    );
                    None
                }
            }
        } else {
            None
        };
        (action, meta, installation)
    };

    let update_info = UpdateInfo {
        metadata: update_metadata.clone(),
        status: UpdateState::Available,
        download: None,
        installation: Some(installation.clone()),
    };

    {
        let mut data = updater_state.data.lock();
        data.state = UpdateState::Available;
        data.last_metadata = Some(update_metadata);
        data.policy = Some(installation);
        #[cfg(feature = "updater")]
        {
            data.pending_action = pending_action;
        }
    }
    crate::services::bridge::emit(
        APP_EVENT,
        serde_json::json!({ "status": "update_found", "data": &update_info }),
    );

    let is_skipped = app
        .try_state::<AppSettingsManager>()
        .and_then(|m| m.get_all().ok())
        .is_some_and(|c| {
            c.runtime
                .app_skipped_updates
                .contains(&update_info.metadata.version)
        });

    if !is_skipped {
        notify(
            app,
            NotificationEvent::AppUpdate(UpdateStage::Available {
                version: update_info.metadata.version.clone(),
            }),
        );
    }

    Ok(Some(update_info))
}

pub async fn get_app_update_info(app: AppHandle) -> Result<Option<UpdateInfo>> {
    let state = app.state::<AppUpdaterState>();
    let data = state.data.lock();
    Ok(data.info())
}

fn is_release_for_channel(
    release: &github_client::Release,
    channel: &str,
    release_prefix: &str,
) -> bool {
    let tag = release.tag_name.to_lowercase();

    if release_prefix.is_empty() || !tag.starts_with(release_prefix) {
        return false;
    }

    let is_pre = release.prerelease
        || tag.contains("beta")
        || tag.contains("alpha")
        || tag.contains("rc")
        || tag.contains("dev")
        || tag.contains("preview");

    match channel {
        "stable" => !is_pre,
        "beta" => true,
        _ => !is_pre,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_stream_follows_host_not_compiled_features() {
        for release_prefix in ["v", "headless-v"] {
            for tag in [
                "v1.2.0",
                "headless-v1.2.0",
                "v1.3.0-beta.1",
                "headless-v1.3.0-beta.1",
            ] {
                let release = github_client::Release {
                    tag_name: tag.into(),
                    prerelease: false,
                    draft: false,
                    assets: vec![],
                    body: None,
                    published_at: None,
                    html_url: String::new(),
                };
                assert!(!is_release_for_channel(&release, "beta", ""));
                assert!(!is_release_for_channel(&release, "beta", "other-v"));
                let same_product = tag.starts_with(release_prefix);
                assert_eq!(
                    is_release_for_channel(&release, "stable", release_prefix),
                    same_product && !tag.contains("beta")
                );
                assert_eq!(
                    is_release_for_channel(&release, "beta", release_prefix),
                    same_product
                );
                assert_eq!(
                    is_release_for_channel(&release, "unknown", release_prefix),
                    same_product && !tag.contains("beta")
                );
                let flagged = github_client::Release {
                    prerelease: true,
                    ..release
                };
                assert!(!is_release_for_channel(&flagged, "stable", release_prefix));
            }
        }
    }

    #[tokio::test]
    async fn checks_preserve_active_downloads_and_staged_updates_across_channels() {
        let app = AppHandle::default();
        let state = AppUpdaterState::default();
        for status in [UpdateState::Downloading, UpdateState::ReadyToRestart] {
            {
                let mut data = state.data.lock();
                data.state = status;
                data.last_metadata = Some(UpdateMetadata {
                    version: "1.2.0".into(),
                    channel: Some("stable".into()),
                    update_available: true,
                    ..Default::default()
                });
                data.downloaded_bytes = 42;
                data.total_bytes = 100;
            }
            let info = fetch_update_inner(&app, "beta", &state)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(info.status, status);
            assert_eq!(info.metadata.channel.as_deref(), Some("stable"));
            assert_eq!(info.metadata.version, "1.2.0");
            assert_eq!(info.download.unwrap().downloaded_bytes, 42);
        }
    }
}
