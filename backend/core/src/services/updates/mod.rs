#[cfg(all(feature = "updater", target_os = "android"))]
mod android;
mod availability;
#[cfg(feature = "updater")]
pub mod binary;
#[cfg(feature = "updater")]
mod download;
#[cfg(feature = "updater")]
pub mod health;
#[cfg(feature = "updater")]
pub mod install;
#[cfg(feature = "updater")]
mod manifest;
#[cfg(feature = "updater")]
pub use manifest::ArtifactKind;
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
/// release with a lower version number. Packages (including DEB/RPM installed by
/// Tauri) only move forward: `rpm -U` refuses downgrades, package managers decide
/// for themselves, and Android version codes cannot decrease.
fn is_offered(installation: &policy::UpdatePolicy, current: &str, release: &str) -> bool {
    use policy::{InstallationKind, UpdateMethod};
    match (installation.method, installation.installation) {
        (_, InstallationKind::Deb | InstallationKind::Rpm) => is_version_newer(current, release),
        (UpdateMethod::Tauri | UpdateMethod::Binary, _) => is_update_candidate(current, release),
        _ => is_version_newer(current, release),
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
        "Update context: current={}, product={}, installation={:?}, method={:?}, target={}-{}, can_install={}, reason={:?}",
        env!("CARGO_PKG_VERSION"),
        app.product().release_prefix,
        installation.installation,
        installation.method,
        std::env::consts::OS,
        std::env::consts::ARCH,
        installation.can_install,
        installation.reason,
    );

    let releases = github_client::get_releases(OWNER, REPO).await?;
    log::debug!("Received {} releases", releases.len());
    let release = select_release(
        &releases,
        channel,
        app.product().release_prefix,
        &installation,
    )
    .await?;
    let Some(release) = release else {
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
    #[cfg(feature = "updater")]
    {
        data.pending_action = None;
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

    if !is_offered(&installation, &current_version_str, release_version_str) {
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

    // No installer of ours applies: announce what the owning package source offers.
    let externally_managed = installation.method == policy::UpdateMethod::Unavailable;
    if externally_managed && !external_update_published(app, release, &installation).await? {
        return Ok(None);
    }
    #[cfg(not(feature = "updater"))]
    if !externally_managed {
        return Ok(None);
    }

    #[cfg(feature = "updater")]
    let pending_action = if externally_managed {
        None
    } else {
        let result = match installation.method {
            policy::UpdateMethod::Tauri => {
                app.host()
                    .check_update(release, &update_metadata.version)
                    .await
            }
            policy::UpdateMethod::Binary | policy::UpdateMethod::Android => {
                signed::check(app, release, &installation).await
            }
            policy::UpdateMethod::Unavailable => Ok(None),
        };
        match result {
            Ok(Some(action)) => installation.can_install.then_some(action),
            Ok(None) => {
                info!(
                    "No compatible update artifact in {}; suppressing update announcement",
                    release.tag_name
                );
                return Ok(None);
            }
            Err(error) => {
                log::warn!(
                    "Could not verify update availability for {}: {error}",
                    release.tag_name
                );
                return Err(crate::utils::types::updater::UpdaterError::UpdateUnavailable(error));
            }
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
        #[cfg(feature = "updater")]
        {
            data.pending_action = pending_action;
        }
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

/// Whether the source that updates an external installation already has `release`:
/// other packages are matched to the release's assets.
async fn external_update_published(
    app: &AppHandle,
    release: &github_client::Release,
    installation: &policy::UpdatePolicy,
) -> Result<bool> {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    // `select_release` already chose the release the AUR publishes.
    if aur_package(installation).is_some() {
        return Ok(true);
    }
    let asset = availability::external_asset(
        release,
        installation.installation,
        app.product().display_name,
        os,
        arch,
    );
    match asset {
        Some(asset) => {
            log::debug!("External update announcement matched upstream asset: {asset}");
            Ok(true)
        }
        None => {
            info!(
                "No matching upstream package in {} for {:?} on {os}-{arch}",
                release.tag_name, installation.installation
            );
            Ok(false)
        }
    }
}

/// Announce updates the supervisor rolled back and stop offering those versions,
/// so a release that cannot start here does not loop through download and rollback.
#[cfg(feature = "updater")]
pub fn report_failed_updates(app: &AppHandle) {
    let failures = binary::take_failed_updates();
    let reported = !failures.is_empty();
    for failure in failures {
        log::warn!(
            "Update {} was rolled back: {}",
            failure.version,
            failure.reason
        );
        // Kept for viewers without OS notifications, such as the headless web UI.
        if let Some(state) = app.try_state::<AppUpdaterState>() {
            state
                .data
                .lock()
                .rolled_back
                .push(crate::utils::types::updater::RolledBackUpdate {
                    version: failure.version.clone(),
                    reason: failure.reason.clone(),
                });
        }
        notify(
            app,
            NotificationEvent::AppUpdate(UpdateStage::Failed {
                error: crate::localized_error!(
                    "backendErrors.updater.rolledBack",
                    "version" => failure.version,
                    "reason" => failure.reason
                ),
            }),
        );
        let Some(manager) = app.try_state::<AppSettingsManager>() else {
            continue;
        };
        let mut skipped = manager
            .get_all()
            .map(|c| c.runtime.app_skipped_updates)
            .unwrap_or_default();
        if !skipped.contains(&failure.version) {
            skipped.push(failure.version);
            if let Err(error) = manager.save_setting(
                "runtime",
                "app_skipped_updates",
                &serde_json::json!(skipped),
            ) {
                log::warn!("Could not remember the failed update: {error}");
            }
        }
    }
    if reported {
        emit_state_changed();
    }
}

pub async fn get_app_update_info(app: AppHandle) -> Result<UpdaterSnapshot> {
    Ok(app.state::<AppUpdaterState>().data.lock().snapshot())
}

fn is_release_for_channel(
    release: &github_client::Release,
    channel: &str,
    release_prefix: &str,
) -> bool {
    if release_prefix.is_empty() || !release.tag_name.to_lowercase().starts_with(release_prefix) {
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

/// The pacman package that owns an AUR installation.
fn aur_package(installation: &policy::UpdatePolicy) -> Option<&str> {
    (installation.installation == policy::InstallationKind::Pacman)
        .then_some(installation.package.as_deref())
        .flatten()
}

/// The release to offer. The AUR publishes stable releases on its own schedule, so
/// an AUR installation is offered the release the AUR has, whatever the channel.
/// A `-git` package builds the default branch, which no release describes.
async fn select_release<'a>(
    releases: &'a [github_client::Release],
    channel: &str,
    release_prefix: &str,
    installation: &policy::UpdatePolicy,
) -> Result<Option<&'a github_client::Release>> {
    let Some(package) = aur_package(installation) else {
        return Ok(latest_release(releases, channel, release_prefix));
    };
    if package.ends_with("-git") {
        return Ok(None);
    }
    let published = availability::aur_version(package)
        .await
        .map_err(crate::utils::types::updater::UpdaterError::UpdateUnavailable)?;
    info!("AUR package {package} publishes {published:?}");
    Ok(published.and_then(|version| release_with_version(releases, release_prefix, &version)))
}

fn release_with_version<'a>(
    releases: &'a [github_client::Release],
    release_prefix: &str,
    version: &str,
) -> Option<&'a github_client::Release> {
    let tag = format!("{release_prefix}{version}").to_lowercase();
    releases
        .iter()
        .find(|release| !release.draft && release.tag_name.to_lowercase() == tag)
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
            Android, Appimage, Deb, Native, Pacman, Portable, Rpm, Server,
        };
        use policy::UpdateMethod;
        let offered = |kind, method, current, release| {
            is_offered(&policy::test_policy(kind, method, None), current, release)
        };
        for (kind, method) in [
            (Native, UpdateMethod::Tauri),
            (Appimage, UpdateMethod::Tauri),
            (Portable, UpdateMethod::Binary),
            (Server, UpdateMethod::Binary),
        ] {
            assert!(offered(kind, method, "0.3.4-beta.1", "0.3.3"));
            assert!(!offered(kind, method, "0.3.4", "0.3.3"));
            assert!(!offered(kind, method, "0.3.4-beta.2", "0.3.4-beta.1"));
        }
        // Packages only move forward, even when Tauri installs them: `rpm -U`
        // refuses downgrades. Android version codes cannot decrease.
        for (kind, method) in [
            (Deb, UpdateMethod::Tauri),
            (Rpm, UpdateMethod::Tauri),
            (Pacman, UpdateMethod::Unavailable),
            (Android, UpdateMethod::Android),
        ] {
            assert!(!offered(kind, method, "0.3.4-beta.1", "0.3.3"));
            assert!(offered(kind, method, "0.3.4-beta.1", "0.3.4"));
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
    async fn externally_managed_installations_do_not_announce_unrelated_packages() {
        let app = AppHandle::default();
        for installation in [
            policy::InstallationKind::Flatpak,
            policy::InstallationKind::Pacman,
            policy::InstallationKind::Container,
            policy::InstallationKind::Deb,
            policy::InstallationKind::Rpm,
        ] {
            let state = AppUpdaterState::default();
            let mut release = candidate();
            release.assets.push(github_client::Asset {
                name: "android-aarch64-99.0.0.apk".into(),
                ..Default::default()
            });
            let policy = policy::test_policy(
                installation,
                policy::UpdateMethod::Unavailable,
                Some("Externally managed"),
            );
            assert!(
                update_for_release(&app, "stable", &release, policy, &state)
                    .await
                    .unwrap()
                    .is_none()
            );
            assert_eq!(state.data.lock().state, UpdateState::Idle);
            assert!(state.data.lock().last_metadata.is_none());
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn matching_external_packages_announce_without_an_in_app_installer() {
        let arch = match std::env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            _ => return,
        };
        for installation in [
            policy::InstallationKind::Flatpak,
            policy::InstallationKind::Pacman,
            policy::InstallationKind::Deb,
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
            // Bundles name packages after the Tauri product name.
            let app = AppHandle::new(
                std::sync::Arc::new(NoHost),
                crate::context::ProductInfo {
                    display_name: "RClone Manager",
                    release_prefix: "v",
                    ..Default::default()
                },
            );
            let state = AppUpdaterState::default();
            let mut release = candidate();
            release.assets.push(github_client::Asset {
                name: format!("RClone.Manager_99.0.0_{arch}.deb"),
                ..Default::default()
            });
            let policy = policy::test_policy(
                installation,
                policy::UpdateMethod::Unavailable,
                Some("Externally managed"),
            );
            let info = update_for_release(&app, "stable", &release, policy, &state)
                .await
                .unwrap()
                .unwrap();
            assert!(info.metadata.update_available);
            assert!(!info.installation.unwrap().can_install);
        }
    }

    #[cfg(feature = "updater")]
    mod native_discovery {
        use super::*;
        use crate::utils::types::updater::{
            AppUpdate, DownloadProgress, InstallOutcome, PendingAppUpdate,
        };
        use std::sync::Arc;

        #[derive(Clone, Copy)]
        enum Check {
            Found,
            Missing,
            Failed,
        }
        struct TestHost(Check);
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
        #[async_trait::async_trait]
        impl crate::context::Host for TestHost {
            fn resolve_paths(
                &self,
                _: &AppHandle,
            ) -> std::result::Result<crate::services::paths::AppPaths, String> {
                Err("Not needed".into())
            }
            fn restart(&self, _: &AppHandle) -> std::result::Result<(), String> {
                panic!("Discovery must not restart")
            }
            async fn check_update(
                &self,
                _: &github_client::Release,
                _: &str,
            ) -> std::result::Result<Option<PendingAppUpdate>, String> {
                match self.0 {
                    Check::Missing => Ok(None),
                    Check::Failed => Err("Invalid manifest signature".into()),
                    Check::Found => Ok(Some(Arc::new(TestUpdate))),
                }
            }
        }

        #[tokio::test]
        async fn missing_or_invalid_artifacts_never_create_available_metadata() {
            for check in [Check::Missing, Check::Failed] {
                let app = AppHandle::new(Arc::new(TestHost(check)), Default::default());
                let state = AppUpdaterState::default();
                state.data.lock().state = UpdateState::Checking;
                let policy = policy::test_policy(
                    policy::InstallationKind::Native,
                    policy::UpdateMethod::Tauri,
                    None,
                );
                let checking = CheckingGuard(&state);
                let result = update_for_release(&app, "beta", &candidate(), policy, &state).await;
                drop(checking);
                match check {
                    Check::Missing => assert!(result.unwrap().is_none()),
                    Check::Failed => assert!(result.is_err()),
                    Check::Found => unreachable!(),
                }
                let data = state.data.lock();
                assert_eq!(data.state, UpdateState::Idle);
                assert!(data.last_metadata.is_none());
                assert!(data.pending_action.is_none());
            }
        }

        #[tokio::test]
        async fn a_failed_recheck_does_not_erase_the_update_found_earlier() {
            let app = AppHandle::new(Arc::new(TestHost(Check::Failed)), Default::default());
            let state = AppUpdaterState::default();
            {
                let mut data = state.data.lock();
                data.state = UpdateState::Checking;
                data.last_metadata = Some(UpdateMetadata {
                    version: "98.0.0".into(),
                    update_available: true,
                    ..Default::default()
                });
                data.pending_action = Some(Arc::new(TestUpdate));
            }
            let policy = policy::test_policy(
                policy::InstallationKind::Native,
                policy::UpdateMethod::Tauri,
                None,
            );
            let checking = CheckingGuard(&state);
            let result = update_for_release(&app, "beta", &candidate(), policy, &state).await;
            drop(checking);
            assert!(result.is_err());
            let data = state.data.lock();
            assert_eq!(data.state, UpdateState::Available);
            assert_eq!(data.info().unwrap().metadata.version, "98.0.0");
            assert!(data.pending_action.is_some());
        }

        #[tokio::test]
        async fn valid_artifacts_are_discovered_even_when_installation_is_disabled() {
            for can_install in [true, false] {
                let app = AppHandle::new(Arc::new(TestHost(Check::Found)), Default::default());
                let state = AppUpdaterState::default();
                let policy = policy::test_policy(
                    policy::InstallationKind::Native,
                    policy::UpdateMethod::Tauri,
                    (!can_install).then_some("Disabled by administrator"),
                );
                let info = update_for_release(&app, "beta", &candidate(), policy, &state)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(info.status, UpdateState::Available);
                assert!(info.metadata.update_available);
                assert_eq!(info.installation.unwrap().can_install, can_install);
                assert_eq!(state.data.lock().pending_action.is_some(), can_install);
            }
        }
    }

    #[test]
    fn aur_installations_follow_the_release_the_aur_publishes() {
        let releases: Vec<_> = ["v0.3.6-beta.1", "v0.3.5", "v0.3.4", "headless-v0.3.5"]
            .into_iter()
            .map(|tag| github_client::Release {
                tag_name: tag.into(),
                prerelease: tag.contains("beta"),
                ..Default::default()
            })
            .collect();
        // The beta channel's newest release is a beta the AUR never publishes.
        assert_eq!(
            latest_release(&releases, "beta", "v").unwrap().tag_name,
            "v0.3.6-beta.1"
        );
        assert_eq!(
            release_with_version(&releases, "v", "0.3.5")
                .unwrap()
                .tag_name,
            "v0.3.5"
        );
        assert_eq!(
            release_with_version(&releases, "headless-v", "0.3.5")
                .unwrap()
                .tag_name,
            "headless-v0.3.5"
        );
        assert!(release_with_version(&releases, "v", "0.3.7").is_none());

        let mut aur = policy::test_policy(
            policy::InstallationKind::Pacman,
            policy::UpdateMethod::Unavailable,
            Some("Externally managed"),
        );
        assert!(aur_package(&aur).is_none());
        aur.package = Some("rclone-manager".into());
        assert_eq!(aur_package(&aur), Some("rclone-manager"));
        aur.installation = policy::InstallationKind::Deb;
        assert!(aur_package(&aur).is_none());
    }

    #[tokio::test]
    async fn git_packages_are_never_offered_a_release() {
        let mut aur = policy::test_policy(
            policy::InstallationKind::Pacman,
            policy::UpdateMethod::Unavailable,
            Some("Externally managed"),
        );
        aur.package = Some("rclone-manager-git".into());
        let releases = [candidate()];
        assert!(
            select_release(&releases, "stable", "v", &aur)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn latest_release_compares_versions_independently_of_list_order() {
        let mut releases: Vec<_> = [
            "v1.2.2",
            "v1.3.0",
            "v1.10.0",
            "v1.11.0-beta.1",
            "headless-v9.0.0",
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
                latest_release(&releases, "stable", "headless-v")
                    .unwrap()
                    .tag_name,
                "headless-v9.0.0"
            );
            releases.rotate_left(1);
        }
        assert!(latest_release(&[], "stable", "v").is_none());
        assert!(latest_release(&releases, "stable", "other-v").is_none());
    }

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
                    ..Default::default()
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
