//! IPC boundary for rcman's configuration vault and deferred application startup.

use super::access::{self, VaultAccess};
use crate::context::AppHandle;
use crate::services::bridge;
use crate::services::settings::AppSettingsManager;
use crate::utils::types::events::{VAULT_STATE_CHANGED, VaultStatePayload};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Vault status returned by the initial status query.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfoResponse {
    /// Whether configuration encryption is active.
    pub enabled: bool,
    /// Whether a password is required before settings can be accessed.
    pub is_locked: bool,
    /// Inactivity limit in seconds; `None` disables automatic locking.
    pub lock_timeout_secs: Option<u64>,
    /// Public UI preference available before password entry.
    pub language: String,
}

/// Publish the current state after application-specific vault operations.
pub fn emit_vault_state(app: &AppHandle, event: &str) {
    let manager = app.state::<AppSettingsManager>();
    bridge::emit(
        VAULT_STATE_CHANGED,
        VaultStatePayload {
            event: event.to_string(),
            is_locked: access::is_locked(app),
            is_enabled: manager.is_vault_enabled(),
            lock_timeout: manager.vault_lock_timeout().map(|d| d.as_secs()),
        },
    );
}

/// Open frontend access after password verification and local task preparation.
fn complete_unlock(app: &AppHandle) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    if manager.is_locked() {
        return Err(access::locked_error());
    }
    let access = app.state::<Arc<VaultAccess>>();
    if !access.is_locked() {
        return Ok(());
    }
    access.unlock();
    if !manager.is_vault_enabled() {
        return Ok(());
    }
    emit_vault_state(app, "unlocked");
    bridge::emit(
        crate::utils::types::events::SYSTEM_SETTINGS_CHANGED,
        crate::utils::types::events::SettingsChangeEvent {
            category: "*".into(),
            key: "*".into(),
            value: serde_json::Value::Null,
        },
    );
    bridge::emit(
        crate::utils::types::events::AUTOMATIONS_CACHE_CHANGED,
        crate::utils::constants::CACHE_UPDATED,
    );
    Ok(())
}

fn vault_error(error: rcman::Error) -> String {
    match error {
        rcman::Error::InvalidPassword | rcman::Error::VaultUnlockFailed => {
            crate::localized_error!("backendErrors.vault.invalidPassword")
        }
        rcman::Error::VaultNotEnabled => crate::localized_error!("backendErrors.vault.notEnabled"),
        other => {
            crate::localized_error!("backendErrors.vault.operationFailed", "error" => other.to_string())
        }
    }
}

fn require_password(password: &str) -> Result<(), String> {
    if password.is_empty() {
        Err(crate::localized_error!("backendErrors.vault.passwordEmpty"))
    } else {
        Ok(())
    }
}

// Own the complete transition in a detached task. Cancelling the IPC/HTTP
// caller must not release serialization while blocking migration is still running.
async fn run_vault_operation<F, Fut>(
    app: AppHandle,
    allow_locked: bool,
    operation: F,
) -> Result<(), String>
where
    F: FnOnce(AppHandle) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,
{
    crate::utils::spawn(async move {
        let state = app.state::<crate::utils::types::state::RcloneState>();
        let _operation = state.vault_operation_lock.try_lock().map_err(|_| {
            crate::localized_error!("backendErrors.vault.operationFailed", "error" => "Another vault operation is in progress")
        })?;
        if !allow_locked && access::is_locked(&app) {
            return Err(access::locked_error());
        }
        operation(app).await
    }).await.map_err(|error| crate::localized_error!("backendErrors.vault.operationFailed", "error" => error.to_string()))?
}

// Argon2 and settings migration must not run on async workers.
async fn update_manager(
    app: &AppHandle,
    operation: impl FnOnce(&AppSettingsManager) -> rcman::Result<()> + Send + 'static,
) -> Result<(), String> {
    let app = app.clone();
    crate::utils::spawn_blocking(move || operation(app.state::<AppSettingsManager>().inner()))
        .await
        .map_err(|error| crate::localized_error!("backendErrors.vault.operationFailed", "error" => error.to_string()))?
        .map_err(vault_error)
}

pub async fn get_vault_info(app: AppHandle) -> Result<VaultInfoResponse, String> {
    let manager = app.state::<AppSettingsManager>();
    let access = app.state::<Arc<VaultAccess>>();
    Ok(VaultInfoResponse {
        enabled: manager.is_vault_enabled(),
        is_locked: access::is_locked(&app),
        lock_timeout_secs: manager
            .vault_lock_timeout()
            .map(|duration| duration.as_secs()),
        language: access.language(),
    })
}

pub async fn unlock_vault(app: AppHandle, password: String) -> Result<(), String> {
    require_password(&password)?;
    run_vault_operation(app, true, move |app| async move {
        let access = app.state::<Arc<VaultAccess>>();
        update_manager(&app, move |manager| {
            if manager.is_locked() {
                manager.unlock(&password)
            } else if manager.verify_vault_password(&password)? {
                Ok(())
            } else {
                Err(rcman::Error::InvalidPassword)
            }
        })
        .await?;
        let initial_startup = app
            .state::<crate::utils::types::state::RcloneState>()
            .initial_startup
            .load(std::sync::atomic::Ordering::Acquire);
        let unlock = async {
            crate::services::automation::runtime::flush_completions(&app).await?;
            if let Some(cache) = app.try_state::<crate::services::alerts::cache::AlertRuleCache>() {
                let cache = cache.inner().clone();
                update_manager(&app, move |manager| cache.flush_firings(manager)).await?;
            }
            if !initial_startup {
                crate::services::automation::runtime::refresh(&app).await?;
            }
            complete_unlock(&app)
        }
        .await;
        if let Err(error) = unlock {
            access.lock();
            if let Err(lock_error) = update_manager(&app, AppSettingsManager::lock).await {
                log::error!(
                    "Failed to re-lock vault after unlock preparation failed: {lock_error}"
                );
            }
            return Err(
                crate::localized_error!("backendErrors.vault.operationFailed", "error" => error),
            );
        }
        if initial_startup {
            // Engine startup and remote auto-starts do not determine whether
            // the password was accepted. Initialization never opens UI access.
            crate::utils::spawn(async move {
                if let Err(error) = crate::services::initialization::initialization(app).await {
                    log::error!("Application initialization after vault unlock failed: {error}");
                }
            });
        }
        Ok(())
    })
    .await
}

pub async fn lock_vault(app: AppHandle) -> Result<(), String> {
    run_vault_operation(app, false, |app| async move {
        if !app.state::<AppSettingsManager>().is_vault_enabled() {
            return Err(vault_error(rcman::Error::VaultNotEnabled));
        }
        app.state::<Arc<VaultAccess>>().lock();
        // Close every UI immediately, even if preparing background task inputs
        // or dropping the storage key takes longer or fails.
        emit_vault_state(&app, "locked");
        if let Err(error) = crate::services::automation::runtime::refresh(&app).await {
            log::warn!("Locking without replacing prepared task inputs: {error}");
        }
        // The rcman callback also covers automatic and non-IPC locks.
        update_manager(&app, AppSettingsManager::lock).await
    })
    .await
}

pub async fn enable_vault(
    app: AppHandle,
    password: String,
    timeout_secs: Option<u64>,
) -> Result<(), String> {
    require_password(&password)?;
    run_vault_operation(app, false, move |app| async move {
        if crate::services::flow::workflow::engine::has_active_workflows() {
            return Err(crate::localized_error!("backendErrors.vault.operationFailed", "error" => "Wait for running workflows to finish before enabling the vault"));
        }
        update_manager(&app, move |manager| {
            manager.enable_vault(&password)?;
            if let Some(seconds) = timeout_secs {
                manager.set_vault_lock_timeout((seconds > 0).then(|| std::time::Duration::from_secs(seconds)))?;
            }
            Ok(())
        }).await?;
        let manager = app.state::<AppSettingsManager>();
        let language = manager.get::<String>("general.language").map_err(vault_error)?;
        let access = app.state::<Arc<VaultAccess>>();
        access.set_language(&language, true);
        crate::services::automation::runtime::refresh(&app).await?;
        if manager.is_locked() { return Err(access::locked_error()); }
        access.unlock();
        emit_vault_state(&app, "enabled");
        Ok(())
    }).await
}

pub async fn disable_vault(app: AppHandle, password: String) -> Result<(), String> {
    require_password(&password)?;
    run_vault_operation(app, false, move |app| async move {
        update_manager(&app, move |manager| manager.disable_vault(&password)).await?;
        crate::services::automation::runtime::refresh(&app).await?;
        app.state::<Arc<VaultAccess>>().unlock();
        emit_vault_state(&app, "disabled");
        Ok(())
    })
    .await
}

pub async fn change_vault_password(
    app: AppHandle,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    require_password(&old_password)?;
    require_password(&new_password)?;
    run_vault_operation(app, false, move |app| async move {
        update_manager(&app, move |manager| {
            manager.change_vault_password(&old_password, &new_password)
        })
        .await?;
        emit_vault_state(&app, "password_changed");
        Ok(())
    })
    .await
}

pub async fn set_vault_lock_timeout(
    app: AppHandle,
    timeout_secs: Option<u64>,
) -> Result<(), String> {
    run_vault_operation(app, false, move |app| async move {
        update_manager(&app, move |manager| {
            manager.set_vault_lock_timeout(
                timeout_secs
                    .filter(|seconds| *seconds > 0)
                    .map(std::time::Duration::from_secs),
            )
        })
        .await?;
        emit_vault_state(&app, "timeout_changed");
        Ok(())
    })
    .await
}

pub async fn touch_vault(app: AppHandle) -> Result<(), String> {
    let manager = app.state::<AppSettingsManager>();
    if manager.is_vault_enabled() && !manager.is_locked() {
        manager.touch_vault().map_err(vault_error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unlock_returns_while_startup_is_pending_and_startup_cannot_undo_a_relock() {
        use crate::utils::types::state::RcloneState;
        use std::sync::atomic::Ordering;

        let directory = tempfile::tempdir().unwrap();
        let (app, access) = super::super::access::tests::app(directory.path());
        access.lock();
        app.state::<AppSettingsManager>().lock().unwrap();
        let state = app.state::<RcloneState>();
        state.initial_startup.store(true, Ordering::Release);
        let startup = state.initialization_lock.lock().await;

        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            unlock_vault(app.clone(), "password".into()),
        )
        .await
        .expect("Unlock must not wait for application startup")
        .unwrap();
        assert!(!access::is_locked(&app));
        assert!(state.initial_startup.load(Ordering::Acquire));

        // Vault commands must also remain available during background startup.
        lock_vault(app.clone()).await.unwrap();
        assert!(access::is_locked(&app));
        state.initial_startup.store(false, Ordering::Release);
        drop(startup);
        crate::services::initialization::initialization(app.clone())
            .await
            .unwrap();
        assert!(access::is_locked(&app));
    }

    #[test]
    fn unlock_completion_keeps_access_closed_until_storage_is_unlocked() {
        let directory = tempfile::tempdir().unwrap();
        let (app, access) = super::super::access::tests::app(directory.path());
        access.lock();
        app.state::<AppSettingsManager>().lock().unwrap();
        assert!(complete_unlock(&app).is_err());
        assert!(access.is_locked());
        app.state::<AppSettingsManager>()
            .unlock("password")
            .unwrap();
        complete_unlock(&app).unwrap();
        assert!(!access.is_locked());
        complete_unlock(&app).unwrap();
        assert!(!access.is_locked());
    }

    #[test]
    fn disabled_timeout_is_explicit_in_queries_and_events() {
        let info = VaultInfoResponse {
            enabled: true,
            is_locked: false,
            lock_timeout_secs: None,
            language: "en-US".into(),
        };
        assert_eq!(
            serde_json::to_value(info).unwrap()["lockTimeoutSecs"],
            serde_json::Value::Null
        );
        let event = VaultStatePayload {
            event: "timeout_changed".into(),
            is_locked: false,
            is_enabled: true,
            lock_timeout: None,
        };
        let value = serde_json::to_value(event).unwrap();
        assert!(value.get("lockTimeout").is_some());
        assert_eq!(value["lockTimeout"], serde_json::Value::Null);
    }

    #[test]
    fn unlock_failure_uses_the_password_error_message() {
        assert_eq!(
            vault_error(rcman::Error::VaultUnlockFailed),
            "backendErrors.vault.invalidPassword"
        );
    }

    #[test]
    fn passwords_reject_empty_values_but_preserve_spaces() {
        assert!(require_password("").is_err());
        assert!(require_password(" password ").is_ok());
    }
}
