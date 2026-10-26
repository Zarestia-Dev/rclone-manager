//! Frontend access follows the real vault lock; only language is public.

use super::{AppSettingsManager, schema::GeneralSettings};
use crate::context::AppHandle;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path, sync::Arc};

#[derive(Clone, Serialize, Deserialize)]
struct InterfacePreferences {
    language: String,
}

struct Session {
    locked: bool,
    revision: u64,
}

/// The access boundary shared by HTTP, IPC, events, protocols and the tray.
pub struct VaultAccess {
    session: Mutex<Session>,
    preferences: Mutex<InterfacePreferences>,
    path: std::path::PathBuf,
    changes: tokio::sync::watch::Sender<u64>,
}

impl VaultAccess {
    pub fn new(directory: &Path, manager: &AppSettingsManager) -> Result<Self, String> {
        let path = directory.join("interface.json");
        let default_preferences = || InterfacePreferences {
            language: GeneralSettings::default().language,
        };
        let preferences = match manager.is_vault_enabled().then(|| std::fs::read(&path)) {
            Some(Ok(bytes)) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                log::warn!("Invalid public language cache; using the system language: {error}");
                default_preferences()
            }),
            None => default_preferences(),
            Some(Err(error)) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("Could not read public language cache: {error}");
                }
                default_preferences()
            }
        };
        let access = Self {
            session: Mutex::new(Session {
                locked: manager.is_locked(),
                revision: 0,
            }),
            preferences: Mutex::new(preferences),
            path,
            changes: tokio::sync::watch::channel(0).0,
        };
        if !manager.is_locked() {
            access.set_language(
                &manager
                    .get::<String>("general.language")
                    .map_err(|e| e.to_string())?,
                manager.is_vault_enabled(),
            );
        }
        Ok(access)
    }

    fn persist(&self, preferences: &InterfacePreferences) -> Result<(), String> {
        let mut file = tempfile::NamedTempFile::new_in(self.path.parent().unwrap())
            .map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut file, preferences).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(&self.path).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn is_locked(&self) -> bool {
        self.session.lock().locked
    }

    pub fn revision(&self) -> u64 {
        self.session.lock().revision
    }

    pub fn permits(&self, revision: u64) -> bool {
        let session = self.session.lock();
        !session.locked && session.revision == revision
    }

    /// Stamp queued events without holding a lock across host callbacks.
    pub fn deliver(&self, public: bool, deliver: impl FnOnce(u64)) {
        let session = self.session.lock();
        if public || !session.locked {
            let revision = session.revision;
            drop(session);
            deliver(revision);
        }
    }

    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub fn lock(&self) {
        let mut session = self.session.lock();
        if !session.locked {
            session.locked = true;
            session.revision = session.revision.wrapping_add(1);
            self.changes.send_replace(session.revision);
        }
    }

    pub fn unlock(&self) {
        let mut session = self.session.lock();
        session.locked = false;
    }

    pub fn language(&self) -> String {
        self.preferences.lock().language.clone()
    }

    pub fn set_language(&self, language: &str, vault_enabled: bool) {
        let mut preferences = self.preferences.lock();
        if preferences.language == language && (!vault_enabled || self.path.exists()) {
            return;
        }
        preferences.language = language.to_owned();
        if vault_enabled && let Err(error) = self.persist(&preferences) {
            log::warn!("Could not save public language cache: {error}");
        }
    }
}

pub fn is_locked(app: &AppHandle) -> bool {
    app.try_state::<Arc<VaultAccess>>()
        .is_some_and(|access| access.is_locked())
        || app
            .try_state::<AppSettingsManager>()
            .is_some_and(|manager| manager.is_locked())
}

pub fn revision(app: &AppHandle) -> Option<u64> {
    app.try_state::<Arc<VaultAccess>>()
        .map(|access| access.revision())
}

pub fn require_session(app: &AppHandle, revision: Option<u64>) -> Result<(), String> {
    if is_locked(app)
        || revision.is_some_and(|revision| {
            app.try_state::<Arc<VaultAccess>>()
                .is_some_and(|access| !access.permits(revision))
        })
    {
        return Err(locked_error());
    }
    Ok(())
}

pub fn locked_error() -> String {
    crate::localized_error!("backendErrors.vault.operationFailed", "error" => rcman::Error::ConfigLocked)
}

/// Native and SSE clients share the same rule, including queued vault notices.
pub fn can_deliver_event(
    app: &AppHandle,
    name: &str,
    payload: &serde_json::Value,
    revision: Option<u64>,
) -> bool {
    let locked = is_locked(app);
    if name == crate::utils::types::events::VAULT_STATE_CHANGED {
        return payload
            .get("isLocked")
            .and_then(serde_json::Value::as_bool)
            .is_none_or(|value| value == locked)
            && payload
                .get("isEnabled")
                .and_then(serde_json::Value::as_bool)
                .is_none_or(|value| {
                    app.try_state::<AppSettingsManager>()
                        .is_some_and(|manager| manager.is_vault_enabled())
                        == value
                });
    }
    !locked
        && revision.is_none_or(|revision| {
            app.try_state::<Arc<VaultAccess>>()
                .is_none_or(|access| access.permits(revision))
        })
}

/// A closed interface only accepts status, password entry and the updater receipt.
pub fn allowed_when_locked(command: &str) -> bool {
    matches!(
        command,
        "get_vault_info" | "unlock_vault" | "confirm_app_update_startup"
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn manager(directory: &Path) -> AppSettingsManager {
        rcman::SettingsManager::builder("access-test", "1")
            .with_config_dir(directory)
            .with_vault()
            .with_schema::<super::super::schema::AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(
                crate::utils::constants::SUB_WORKFLOWS,
            ))
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(
                crate::utils::constants::SUB_QUICK_RUNS,
            ))
            .build()
            .unwrap()
    }

    pub(crate) fn app(directory: &Path) -> (AppHandle, Arc<VaultAccess>) {
        app_with_transport(directory, None)
    }

    fn app_with_transport(
        directory: &Path,
        transport: Option<Arc<dyn crate::rclone::backend::RcloneTransport>>,
    ) -> (AppHandle, Arc<VaultAccess>) {
        use crate::rclone::backend::{BackendManager, routing_transport::RoutingTransport};
        use crate::utils::types::state::RcloneState;
        use std::sync::atomic::AtomicBool;
        let app = AppHandle::default();
        let manager = manager(directory);
        manager
            .save_setting("general", "language", &serde_json::json!("tr-TR"))
            .unwrap();
        manager.enable_vault("password").unwrap();
        let access = Arc::new(VaultAccess::new(directory, &manager).unwrap());
        access.unlock();
        app.manage(access.clone());
        app.manage(manager);
        app.manage(crate::services::automation::runtime::RuntimeTasks::default());
        app.manage(BackendManager::new());
        app.manage(crate::rclone::state::automations::AutomationsCache::new());
        app.manage(RcloneState {
            poller_visible: AtomicBool::new(true),
            ..RcloneState::new(
                reqwest::Client::new(),
                transport.unwrap_or_else(|| Arc::new(RoutingTransport::new(app.clone()))),
            )
        });
        (app, access)
    }

    struct DelayedTransport {
        entered: tokio::sync::Notify,
        released: tokio::sync::Notify,
        fail: bool,
    }

    #[async_trait::async_trait]
    impl crate::rclone::backend::RcloneTransport for DelayedTransport {
        async fn kind(&self) -> crate::rclone::backend::transport::TransportKind {
            crate::rclone::backend::transport::TransportKind::HttpDaemon
        }
        async fn rpc(
            &self,
            _endpoint: &str,
            _payload: Option<&serde_json::Value>,
        ) -> Result<serde_json::Value, crate::rclone::backend::BackendError> {
            self.entered.notify_one();
            self.released.notified().await;
            if self.fail {
                Err(crate::rclone::backend::BackendError::Other(
                    "private response error".into(),
                ))
            } else {
                Ok(serde_json::json!({"private": ["response"]}))
            }
        }
        async fn read_file(
            &self,
            _remote: &str,
            _path: &str,
            _range: Option<(u64, Option<u64>)>,
        ) -> Result<
            Box<dyn tokio::io::AsyncRead + Unpin + Send>,
            crate::rclone::backend::BackendError,
        > {
            Err(crate::rclone::backend::BackendError::Other("unused".into()))
        }
    }

    #[tokio::test]
    async fn pending_command_results_and_errors_cannot_cross_a_lock_transition() {
        for fail in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let transport = Arc::new(DelayedTransport {
                entered: tokio::sync::Notify::new(),
                released: tokio::sync::Notify::new(),
                fail,
            });
            let (app, access) = app_with_transport(directory.path(), Some(transport.clone()));
            let command = crate::utils::spawn(async move {
                crate::app::dispatch::bridge_dispatch(
                    &app,
                    "get_remote_types",
                    serde_json::json!({}),
                )
                .await
            });
            transport.entered.notified().await;
            access.lock();
            access.unlock();
            transport.released.notify_one();
            assert_eq!(
                command.await.unwrap().unwrap_err(),
                serde_json::json!(locked_error())
            );
        }
    }

    #[tokio::test]
    async fn language_changes_and_resets_update_only_the_public_preference() {
        let directory = tempfile::tempdir().unwrap();
        let (app, access) = app(directory.path());
        super::super::operations::core::save_setting(
            app.clone(),
            "general".into(),
            "language".into(),
            serde_json::json!("zh-CN"),
        )
        .await
        .unwrap();
        assert_eq!(access.language(), "zh-CN");
        let public: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.path().join("interface.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(public, serde_json::json!({"language": "zh-CN"}));
        super::super::operations::core::reset_setting(
            app.clone(),
            "general".into(),
            "language".into(),
        )
        .await
        .unwrap();
        assert_eq!(access.language(), GeneralSettings::default().language);
    }

    #[tokio::test]
    async fn locked_interface_blocks_queries_but_scheduled_workflows_still_execute() {
        use crate::{
            app::dispatch::bridge_dispatch,
            rclone::state::automations::AutomationsCache,
            services::flow::workflow::types::{
                WorkflowDefinition, WorkflowNode, WorkflowNodeCategory,
            },
        };
        let directory = tempfile::tempdir().unwrap();
        let (app, access) = app(directory.path());
        let workflow = WorkflowDefinition {
            id: "locked-workflow".into(),
            name: "Private workflow".into(),
            nodes: vec![WorkflowNode {
                id: "trigger".into(),
                node_type: "cron".into(),
                category: WorkflowNodeCategory::Trigger,
                config: serde_json::json!({"cronExpression": "0 3 * * *"}),
                ..Default::default()
            }],
            ..Default::default()
        };
        app.state::<AppSettingsManager>()
            .sub_settings(crate::utils::constants::SUB_WORKFLOWS)
            .unwrap()
            .set(&workflow.id, &workflow)
            .unwrap();
        app.state::<AutomationsCache>()
            .load_from_workflows(std::slice::from_ref(&workflow), "Local")
            .await
            .unwrap();
        crate::services::automation::runtime::refresh(&app)
            .await
            .unwrap();
        super::super::vault::lock_vault(app.clone()).await.unwrap();
        assert!(access.is_locked());
        for command in [
            "load_settings",
            "request_app_exit",
            "shutdown_app",
            "check_pending_app_exit",
            "list_workflows",
            "list_quick_runs",
            "get_automations",
            "get_logs",
            "disable_vault",
            "set_vault_lock_timeout",
            "unknown",
        ] {
            let error = bridge_dispatch(&app, command, serde_json::json!({}))
                .await
                .unwrap_err();
            assert_eq!(error, serde_json::json!(locked_error()), "{command}");
        }
        let info = bridge_dispatch(&app, "get_vault_info", serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(info["language"], "tr-TR");
        assert_eq!(info["isLocked"], true);
        assert!(
            crate::services::automation::engine::execute_automation(&workflow.id, &app, None)
                .await
                .unwrap()
        );
        assert!(app.state::<AppSettingsManager>().is_locked());
        assert!(app.state::<AppSettingsManager>().get_all().is_err());
        super::super::vault::unlock_vault(app.clone(), "password".into())
            .await
            .unwrap();
        let stored: WorkflowDefinition = app
            .state::<AppSettingsManager>()
            .sub_settings(crate::utils::constants::SUB_WORKFLOWS)
            .unwrap()
            .get(&workflow.id)
            .unwrap();
        assert!(stored.last_executed_at.is_some());
        assert!(!access.is_locked());
        assert!(rcman::vault::is_vault_content(
            &std::fs::read_to_string(directory.path().join("settings.json")).unwrap()
        ));
    }

    #[tokio::test]
    async fn ui_reentry_always_checks_password_even_with_a_live_runtime_key() {
        let directory = tempfile::tempdir().unwrap();
        let (app, access) = app(directory.path());
        access.lock();
        assert!(!app.state::<AppSettingsManager>().is_locked());
        assert!(
            super::super::vault::unlock_vault(app.clone(), "incorrect".into())
                .await
                .is_err()
        );
        assert!(access.is_locked());
        super::super::vault::unlock_vault(app.clone(), "password".into())
            .await
            .unwrap();
        assert!(!access.is_locked());
        assert!(
            crate::app::dispatch::bridge_dispatch(&app, "load_settings", serde_json::json!({}))
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn events_stay_internal_during_lock_and_old_queued_events_are_revoked() {
        use crate::{
            services::bridge::EventBridge,
            utils::types::events::{JOB_CACHE_CHANGED, VAULT_STATE_CHANGED},
        };
        let directory = tempfile::tempdir().unwrap();
        let (app, access) = app(directory.path());
        let bridge = EventBridge::new(10, None);
        bridge.set_frontend_access(access.clone());
        let mut internal = bridge.subscribe();
        let mut frontend = bridge.subscribe_frontend();
        bridge.emit(JOB_CACHE_CHANGED, serde_json::json!({"remote": "private"}));
        let queued = frontend.recv().await.unwrap();
        access.lock();
        bridge.emit(JOB_CACHE_CHANGED, serde_json::json!({"remote": "private"}));
        assert!(internal.recv().await.is_ok());
        assert!(internal.recv().await.is_ok());
        assert!(frontend.try_recv().is_err());
        bridge.emit(VAULT_STATE_CHANGED, serde_json::json!({"isLocked": true}));
        assert_eq!(
            frontend.recv().await.unwrap().event.event,
            VAULT_STATE_CHANGED
        );
        access.unlock();
        assert!(!access.permits(queued.revision));
        drop(app);
    }

    #[tokio::test]
    async fn stale_vault_notices_and_raw_locked_data_are_never_delivered() {
        use crate::utils::types::events::{JOB_CACHE_CHANGED, VAULT_STATE_CHANGED};
        let directory = tempfile::tempdir().unwrap();
        let (app, access) = app(directory.path());
        assert!(can_deliver_event(
            &app,
            VAULT_STATE_CHANGED,
            &serde_json::json!({"isLocked": false, "isEnabled": true}),
            None
        ));
        access.lock();
        assert!(!can_deliver_event(
            &app,
            VAULT_STATE_CHANGED,
            &serde_json::json!({"isLocked": false}),
            None
        ));
        assert!(can_deliver_event(
            &app,
            VAULT_STATE_CHANGED,
            &serde_json::json!({"isLocked": true}),
            None
        ));
        access.unlock();
        app.state::<AppSettingsManager>().lock().unwrap();
        assert!(!can_deliver_event(
            &app,
            JOB_CACHE_CHANGED,
            &serde_json::json!({"private": true}),
            None
        ));
        assert!(!can_deliver_event(
            &app,
            VAULT_STATE_CHANGED,
            &serde_json::json!({"isLocked": true, "isEnabled": false}),
            None
        ));
    }

    #[test]
    fn startup_access_respects_a_password_provided_before_ui_initialization() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());
        manager.enable_vault("password").unwrap();
        manager.lock().unwrap();
        let locked = VaultAccess::new(directory.path(), &manager).unwrap();
        assert!(locked.is_locked());

        manager.unlock("password").unwrap();
        let unlocked = VaultAccess::new(directory.path(), &manager).unwrap();
        assert!(!unlocked.is_locked());
    }

    #[test]
    fn corrupt_language_cache_does_not_unlock_or_prevent_vault_startup() {
        let directory = tempfile::tempdir().unwrap();
        let manager = manager(directory.path());
        manager.enable_vault("password").unwrap();
        manager.lock().unwrap();
        std::fs::write(directory.path().join("interface.json"), "invalid").unwrap();
        let access = VaultAccess::new(directory.path(), &manager).unwrap();
        assert!(access.is_locked());
        assert!(manager.get_all().is_err());
        assert_eq!(access.language(), GeneralSettings::default().language);
    }
}
