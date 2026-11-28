#[cfg(target_os = "android")]
mod android;
pub mod binary;
mod download;
pub mod install;
mod manifest;
mod package;
pub use manifest::ArtifactKind;
pub mod policy;
mod signed;

use crate::context::AppHandle;
use crate::services::settings::AppSettingsManager;
use crate::utils::github_client::{OWNER, REPO};
use crate::utils::types::{
    events::{APP_EVENT, UPDATER_STATE_CHANGED, UpdaterStateChanged, app_event_status},
    updater::{
        AppUpdaterState, Result, UpdateInfo, UpdateMetadata, UpdateState, UpdaterError,
        UpdaterSnapshot, check_finished_at,
    },
};
use crate::utils::{
    app::notification::{NotificationEvent, UpdateStage, notify},
    github_client,
};
use log::info;

pub(crate) fn emit_state_changed() {
    crate::services::bridge::emit(UPDATER_STATE_CHANGED, UpdaterStateChanged::App);
}

/// Cancellation or a panicking dependency must not leave future checks blocked.
/// A check that ends without a verdict returns to the state it interrupted, so an
/// already discovered update stays available.
struct CheckingGuard<'a>(&'a AppUpdaterState);

impl Drop for CheckingGuard<'_> {
    fn drop(&mut self) {
        let mut data = self.0.data.lock();
        if data.state == UpdateState::Checking {
            data.settle();
        }
        drop(data);
        emit_state_changed();
    }
}

use crate::utils::version::{clean_app_version, is_update_candidate, is_version_newer};

/// Installers that replace the running build may move a pre-release to a stable
/// release with a lower version number, so that leaving the beta channel does not
/// wait for the next stable version. That includes the packages the core installs
/// (`dpkg -i`, `pacman -U` and `rpm -U --oldpackage` accept an older package, and
/// the MSI allows downgrades). On the beta channel that would be a downgrade: its
/// newest release is older than this build only when this build's own release is
/// missing (a local build, or a release that was withdrawn). Only forward:
/// packages another source manages, and Android, whose version codes cannot
/// decrease.
fn is_offered(
    installation: &policy::UpdatePolicy,
    channel: &str,
    current: &str,
    release: &str,
) -> bool {
    let core_installs =
        !installation.external && installation.installation != policy::InstallationKind::Android;
    if core_installs && channel != "beta" {
        is_update_candidate(current, release)
    } else {
        is_version_newer(current, release)
    }
}

pub async fn fetch_update(app: AppHandle, channel: String) -> Result<Option<UpdateInfo>> {
    let updater_state = app.state::<AppUpdaterState>();
    fetch_update_inner(&app, &channel, &updater_state).await
}

async fn fetch_update_inner(
    app: &AppHandle,
    channel: &str,
    updater_state: &AppUpdaterState,
) -> Result<Option<UpdateInfo>> {
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

        // Keep any previously discovered update, and the failure of its last
        // download, until this check reaches a verdict: a network failure says
        // nothing about whether the update still exists.
        data.state = UpdateState::Checking;
    }

    let _checking = CheckingGuard(updater_state);
    let result = check_releases(app, channel, installation, updater_state).await;
    // Recorded before the guard announces the new state, so every viewer sees it.
    let mut data = updater_state.data.lock();
    data.last_checked_at = Some(check_finished_at());
    data.last_error = result.as_ref().err().map(UpdaterError::localized);
    drop(data);
    result
}

async fn check_releases(
    app: &AppHandle,
    channel: &str,
    installation: policy::UpdatePolicy,
    updater_state: &AppUpdaterState,
) -> Result<Option<UpdateInfo>> {
    info!("Checking for app updates on channel: {channel}");
    log::debug!(
        "Update context: current={}, product={:?}, installation={:?}, external={}, target={}-{}, can_install={}, reason={:?}",
        env!("CARGO_PKG_VERSION"),
        app.product().release_prefix,
        installation.installation,
        installation.external,
        std::env::consts::OS,
        std::env::consts::ARCH,
        installation.can_install,
        installation.reason,
    );

    let releases = github_client::get_releases(OWNER, REPO).await?;
    log::debug!("Received {} releases", releases.len());
    let Some(release) = latest_release(&releases, channel, app.product().release_prefix) else {
        info!("No suitable release found for channel: {channel}");
        forget_update(updater_state);
        return Ok(None);
    };

    let result = update_for_release(app, channel, release, installation, updater_state).await;
    if matches!(result, Ok(None)) {
        forget_update(updater_state);
    }
    result
}

/// Drop a previously discovered update after a check found that none applies.
fn forget_update(updater_state: &AppUpdaterState) {
    let mut data = updater_state.data.lock();
    data.last_metadata = None;
    data.failure_message = None;
    data.pending_action = None;
}

/// What a check found for this installation: the update to install, when it may
/// be installed, and the policy to announce it with. `None` when the release has
/// no update to announce.
fn announce(
    result: std::result::Result<crate::utils::types::updater::ReleaseArtifact, String>,
    installation: policy::UpdatePolicy,
    tag: &str,
) -> Result<
    Option<(
        Option<crate::utils::types::updater::PendingAppUpdate>,
        policy::UpdatePolicy,
    )>,
> {
    use crate::utils::types::updater::ReleaseArtifact;
    match result {
        Ok(ReleaseArtifact::Found(action)) => Ok(Some((
            installation.can_install.then_some(action),
            installation,
        ))),
        // A build that is no longer made must not hear "up to date" forever.
        Ok(ReleaseArtifact::NotBuilt) => {
            info!("{tag} has no update for this installation; announcing it as a manual update");
            let installation = policy::UpdatePolicy {
                can_install: false,
                reason: Some(crate::localized_error!("backendErrors.updater.notBuilt")),
                ..installation
            };
            Ok(Some((None, installation)))
        }
        Ok(ReleaseArtifact::Unpublished) => {
            info!("No update manifest in {tag}; suppressing update announcement");
            Ok(None)
        }
        Err(error) => {
            log::warn!("Could not verify update availability for {tag}: {error}");
            Err(UpdaterError::UpdateUnavailable(error))
        }
    }
}

async fn update_for_release(
    app: &AppHandle,
    channel: &str,
    release: &github_client::Release,
    installation: policy::UpdatePolicy,
    updater_state: &AppUpdaterState,
) -> Result<Option<UpdateInfo>> {
    let current_version_str = env!("CARGO_PKG_VERSION").to_string();
    let release_version_str = clean_app_version(&release.tag_name);

    if !is_offered(
        &installation,
        channel,
        &current_version_str,
        release_version_str,
    ) {
        info!("App is up to date (current: {current_version_str}, latest: {release_version_str})");
        return Ok(None);
    }

    info!("Update found: {release_version_str} (current: {current_version_str})");

    let update_metadata = UpdateMetadata {
        version: release_version_str.to_string(),
        current_version: current_version_str,
        release_tag: Some(release.tag_name.clone()),
        release_notes: release.body.clone(),
        release_date: release.published_at.clone(),
        release_url: Some(release.html_url.clone()),
        update_available: true,
        prerelease: is_prerelease(release),
        channel: Some(channel.to_string()),
    };

    // No installer of ours applies: announce it, the owning package source installs it.
    let externally_managed = installation.external;
    let (pending_action, installation) = if externally_managed {
        (None, installation)
    } else {
        let result = signed::check(app, release, &installation).await;
        match announce(result, installation, &release.tag_name)? {
            Some(found) => found,
            None => return Ok(None),
        }
    };
    info!(
        "Update available: version={}, installation={:?}, can_install={}",
        update_metadata.version, installation.installation, installation.can_install
    );

    let update_info = UpdateInfo {
        metadata: update_metadata.clone(),
        status: UpdateState::Available,
        download: None,
        installation: Some(installation.clone()),
    };

    {
        let mut data = updater_state.data.lock();
        data.state = UpdateState::Available;
        // A failed download belongs to the release it tried to install.
        if data
            .last_metadata
            .as_ref()
            .is_none_or(|known| known.version != update_metadata.version)
        {
            data.failure_message = None;
        }
        data.last_metadata = Some(update_metadata);
        data.policy = Some(installation);
        data.pending_action = pending_action;
    }
    crate::services::bridge::emit(
        APP_EVENT,
        serde_json::json!({ "status": app_event_status::UPDATE_FOUND, "data": &update_info }),
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

pub async fn get_app_update_info(app: AppHandle) -> Result<UpdaterSnapshot> {
    Ok(app.state::<AppUpdaterState>().data.lock().snapshot())
}

/// The release this build came from, for its release notes.
pub async fn get_app_release_notes(app: AppHandle) -> Result<UpdateMetadata> {
    let version = env!("CARGO_PKG_VERSION");
    let tag = format!("{}{version}", app.product().release_prefix);
    let release = github_client::get_release_by_tag(OWNER, REPO, &tag).await?;
    Ok(UpdateMetadata {
        version: version.to_string(),
        current_version: version.to_string(),
        prerelease: is_prerelease(&release),
        release_notes: release.body,
        release_date: release.published_at,
        release_url: Some(release.html_url),
        release_tag: Some(release.tag_name),
        ..Default::default()
    })
}

fn is_release_for_channel(
    release: &github_client::Release,
    channel: &str,
    release_prefix: &str,
) -> bool {
    if !release.tag_name.to_lowercase().starts_with(release_prefix) {
        return false;
    }
    channel == "beta" || !is_prerelease(release)
}

/// Only the GitHub flag or a version suffix (`1.2.3-beta.1`) marks a pre-release,
/// never text elsewhere in the tag.
fn is_prerelease(release: &github_client::Release) -> bool {
    release.prerelease
        || crate::utils::version::split_version_parts(clean_app_version(
            &release.tag_name.to_lowercase(),
        ))
        .1
        .is_some()
}

fn latest_release<'a>(
    releases: &'a [github_client::Release],
    channel: &str,
    release_prefix: &str,
) -> Option<&'a github_client::Release> {
    releases
        .iter()
        .filter(|release| {
            !release.draft && is_release_for_channel(release, channel, release_prefix)
        })
        .reduce(|latest, candidate| {
            if is_version_newer(&latest.tag_name, &candidate.tag_name) {
                candidate
            } else {
                latest
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaving_beta_does_not_wait_for_the_next_stable_version() {
        use policy::InstallationKind::{
            Android, Appimage, Deb, MacApp, Msi, Nsis, Pacman, Portable, Rpm, Server,
        };
        let offered = |kind, external, current, release| {
            is_offered(
                &policy::test_policy(kind, external, None),
                "stable",
                current,
                release,
            )
        };
        let offered_on_beta = |kind, external, current, release| {
            is_offered(
                &policy::test_policy(kind, external, None),
                "beta",
                current,
                release,
            )
        };
        for kind in [
            MacApp, Appimage, Portable, Server, Deb, Rpm, Pacman, Nsis, Msi,
        ] {
            let external = false;
            assert!(offered(kind, external, "0.3.4-beta.1", "0.3.3"));
            assert!(!offered(kind, external, "0.3.4", "0.3.3"));
            assert!(!offered(kind, external, "0.3.4-beta.2", "0.3.4-beta.1"));
            // The beta channel never goes back to an older stable release, as when
            // this build's own release is missing; newer releases are still offered.
            assert!(!offered_on_beta(kind, external, "0.3.7-beta.1", "0.3.6"));
            assert!(offered_on_beta(kind, external, "0.3.7-beta.1", "0.3.7"));
            assert!(offered_on_beta(
                kind,
                external,
                "0.3.7-beta.1",
                "0.3.7-beta.2"
            ));
        }
        // Only forward: another source manages its own packages, and Android
        // version codes cannot decrease.
        for (kind, external) in [(Deb, true), (Pacman, true), (Android, false)] {
            assert!(!offered(kind, external, "0.3.4-beta.1", "0.3.3"));
            assert!(offered(kind, external, "0.3.4-beta.1", "0.3.4"));
        }
    }

    #[test]
    fn the_stable_channel_offers_its_latest_release_to_a_beta_build() {
        let release = |tag: &str, prerelease: bool| github_client::Release {
            tag_name: tag.into(),
            prerelease,
            ..Default::default()
        };
        let releases = [
            release("v0.3.3", false),
            release("v0.3.4-beta.1", true),
            release("headless-v0.3.3", false),
        ];
        let stable = latest_release(&releases, "stable", "v").unwrap();
        assert_eq!(stable.tag_name, "v0.3.3");
        let beta = latest_release(&releases, "beta", "v").unwrap();
        assert_eq!(beta.tag_name, "v0.3.4-beta.1");
    }

    #[tokio::test]
    async fn a_panicking_update_check_returns_to_idle_and_can_be_retried() {
        let state = std::sync::Arc::new(AppUpdaterState::default());
        state.data.lock().state = UpdateState::Checking;
        let checking = state.clone();
        let task = crate::utils::spawn(async move {
            let _guard = CheckingGuard(&checking);
            panic!("TLS initialization failure fixture");
        });
        assert!(task.await.unwrap_err().is_panic());
        assert_eq!(state.data.lock().state, UpdateState::Idle);
        state.data.lock().state = UpdateState::Checking;
        let guard = CheckingGuard(&state);
        state.data.lock().state = UpdateState::Available;
        drop(guard);
        assert_eq!(state.data.lock().state, UpdateState::Available);
    }

    #[tokio::test]
    async fn cancellation_clears_checking_without_overwriting_other_update_states() {
        let state = std::sync::Arc::new(AppUpdaterState::default());
        state.data.lock().state = UpdateState::Checking;
        let checking = state.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = crate::utils::spawn(async move {
            let _guard = CheckingGuard(&checking);
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(state.data.lock().state, UpdateState::Idle);
        for status in [
            UpdateState::Available,
            UpdateState::Downloading,
            UpdateState::ReadyToRestart,
            UpdateState::Installing,
        ] {
            state.data.lock().state = status;
            drop(CheckingGuard(&state));
            assert_eq!(state.data.lock().state, status);
        }
    }

    #[tokio::test]
    async fn an_interrupted_check_keeps_a_known_update_available() {
        let state = AppUpdaterState::default();
        {
            let mut data = state.data.lock();
            data.state = UpdateState::Checking;
            data.last_metadata = Some(UpdateMetadata {
                version: "1.2.0".into(),
                update_available: true,
                ..Default::default()
            });
        }
        drop(CheckingGuard(&state));
        assert_eq!(state.data.lock().state, UpdateState::Available);
        assert!(state.data.lock().info().is_some());

        forget_update(&state);
        state.data.lock().state = UpdateState::Checking;
        drop(CheckingGuard(&state));
        assert_eq!(state.data.lock().state, UpdateState::Idle);
        assert!(state.data.lock().info().is_none());
    }

    fn candidate() -> github_client::Release {
        github_client::Release {
            tag_name: "v99.0.0".into(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn external_installations_announce_releases_without_an_in_app_installer() {
        for installation in [
            policy::InstallationKind::Flatpak,
            policy::InstallationKind::Pacman,
            policy::InstallationKind::Container,
            policy::InstallationKind::Deb,
            policy::InstallationKind::Rpm,
        ] {
            struct NoHost;
            #[async_trait::async_trait]
            impl crate::context::Host for NoHost {
                fn resolve_paths(
                    &self,
                    _: &AppHandle,
                ) -> std::result::Result<crate::services::paths::AppPaths, String> {
                    Err("Not needed".into())
                }
                fn restart(&self, _: &AppHandle) -> std::result::Result<(), String> {
                    Err("Not needed".into())
                }
            }
            let app = AppHandle::new(std::sync::Arc::new(NoHost), Default::default());
            let state = AppUpdaterState::default();
            let policy = policy::test_policy(installation, true, Some("Externally managed"));
            let info = update_for_release(&app, "stable", &candidate(), policy, &state)
                .await
                .unwrap()
                .unwrap();
            assert!(info.metadata.update_available);
            assert!(!info.installation.unwrap().can_install);
        }
    }

    mod discovery {
        use super::*;
        use crate::utils::types::updater::{
            AppUpdate, DownloadProgress, InstallOutcome, ReleaseArtifact,
        };
        use std::sync::Arc;

        struct TestUpdate;
        #[async_trait::async_trait]
        impl AppUpdate for TestUpdate {
            fn version(&self) -> &str {
                "99.0.0"
            }
            async fn download(&self, _: DownloadProgress) -> std::result::Result<Vec<u8>, String> {
                panic!("Discovery must not download a payload")
            }
            fn install(&self, _: &[u8]) -> std::result::Result<InstallOutcome, String> {
                panic!("Discovery must not install")
            }
        }

        fn policy(can_install: bool) -> policy::UpdatePolicy {
            policy::test_policy(
                policy::InstallationKind::MacApp,
                false,
                (!can_install).then_some("Disabled by administrator"),
            )
        }

        #[test]
        fn missing_or_invalid_artifacts_never_announce_an_update() {
            let missing = announce(Ok(ReleaseArtifact::Unpublished), policy(true), "v99.0.0");
            assert!(missing.unwrap().is_none());
            let failed = announce(
                Err("Invalid manifest signature".into()),
                policy(true),
                "v99.0.0",
            );
            assert!(failed.is_err());
        }

        #[test]
        fn a_release_without_this_installation_is_announced_as_a_manual_update() {
            let (action, installation) =
                announce(Ok(ReleaseArtifact::NotBuilt), policy(true), "v99.0.0")
                    .unwrap()
                    .unwrap();
            assert!(action.is_none());
            assert!(!installation.can_install);
            assert!(
                installation
                    .reason
                    .unwrap()
                    .contains("backendErrors.updater.notBuilt")
            );
        }

        #[test]
        fn valid_artifacts_are_discovered_even_when_installation_is_disabled() {
            for can_install in [true, false] {
                let found = ReleaseArtifact::Found(Arc::new(TestUpdate));
                let (action, installation) = announce(Ok(found), policy(can_install), "v99.0.0")
                    .unwrap()
                    .unwrap();
                assert_eq!(installation.can_install, can_install);
                assert_eq!(action.is_some(), can_install);
            }
        }
    }

    #[test]
    fn latest_release_compares_versions_independently_of_list_order() {
        let mut releases: Vec<_> = [
            "v1.2.2",
            "v1.3.0",
            "v1.10.0",
            "v1.11.0-beta.1",
            "server-v9.0.0",
        ]
        .into_iter()
        .map(|tag| github_client::Release {
            tag_name: tag.into(),
            ..Default::default()
        })
        .collect();
        let mut draft = releases[0].clone();
        draft.tag_name = "v99.0.0".into();
        draft.draft = true;
        releases.push(draft);
        for _ in 0..releases.len() {
            assert_eq!(
                latest_release(&releases, "stable", "v").unwrap().tag_name,
                "v1.10.0"
            );
            assert_eq!(
                latest_release(&releases, "beta", "v").unwrap().tag_name,
                "v1.11.0-beta.1"
            );
            assert_eq!(
                latest_release(&releases, "stable", "server-v")
                    .unwrap()
                    .tag_name,
                "server-v9.0.0"
            );
            releases.rotate_left(1);
        }
        assert!(latest_release(&[], "stable", "v").is_none());
        assert!(latest_release(&releases, "stable", "other-v").is_none());
    }

    #[test]
    fn release_stream_follows_host_not_compiled_features() {
        for release_prefix in ["v", "server-v"] {
            for tag in [
                "v1.2.0",
                "server-v1.2.0",
                "headless-v1.2.0",
                "v1.3.0-beta.1",
                "server-v1.3.0-beta.1",
            ] {
                let release = github_client::Release {
                    tag_name: tag.into(),
                    ..Default::default()
                };
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
