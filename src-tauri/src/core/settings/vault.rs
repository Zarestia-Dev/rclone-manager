//! IPC boundary for rcman's configuration vault and deferred application startup.

use crate::core::bridge;
use crate::core::settings::AppSettingsManager;
use crate::utils::context::{AppHandle, Manager};
use crate::utils::types::events::{VAULT_STATE_CHANGED, VaultStatePayload};
use serde::{Deserialize, Serialize};
use std::time::Duration;

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
}

/// Publish the current state after application-specific vault operations.
pub fn emit_vault_state(manager: &AppSettingsManager, event: &str) {
    bridge::emit(
        VAULT_STATE_CHANGED,
        VaultStatePayload {
            event: event.to_string(),
            is_locked: manager.is_locked(),
            is_enabled: manager.is_vault_enabled(),
            lock_timeout: manager
                .vault_lock_timeout()
                .map(|duration| duration.as_secs()),
        },
    );
}

fn vault_error(error: rcman::Error) -> String {
    match error {
        rcman::Error::InvalidPassword => {
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

// Argon2 and settings migration perform blocking CPU and filesystem work.
async fn run_vault_operation(
    app: &AppHandle,
    operation: impl FnOnce(&AppSettingsManager) -> rcman::Result<()> + Send + 'static,
) -> Result<(), String> {
    let state = app.state::<crate::utils::types::state::RcloneState>();
    let _operation = state.vault_operation_lock.lock().await;
    let app = app.clone();
    crate::utils::spawn_blocking(move || operation(app.state::<AppSettingsManager>().inner()))
        .await
        .map_err(|error| crate::localized_error!("backendErrors.vault.operationFailed", "error" => error.to_string()))?
        .map_err(vault_error)
}

#[bridge]
pub async fn get_vault_info(app: AppHandle) -> Result<VaultInfoResponse, String> {
    let manager = app.state::<AppSettingsManager>();
    Ok(VaultInfoResponse {
        enabled: manager.is_vault_enabled(),
        is_locked: manager.is_locked()
            || (manager.is_vault_enabled()
                && app
                    .state::<crate::utils::types::state::RcloneState>()
                    .initial_startup
                    .load(std::sync::atomic::Ordering::Acquire)),
        lock_timeout_secs: manager
            .vault_lock_timeout()
            .map(|duration| duration.as_secs()),
    })
}

#[bridge]
pub async fn unlock_vault(app: AppHandle, password: String) -> Result<(), String> {
    require_password(&password)?;
    let is_initial_startup = app
        .state::<crate::utils::types::state::RcloneState>()
        .initial_startup
        .load(std::sync::atomic::Ordering::Acquire);
    run_vault_operation(&app, move |manager| manager.unlock(&password)).await?;

    // This is a no-op after successful startup; normal unlocks do not restart services.
    if let Err(error) = crate::core::initialization::initialization(app.clone()).await {
        let manager = app.state::<AppSettingsManager>();
        if let Err(lock_error) = manager.lock() {
            log::error!("Failed to re-lock vault after startup failure: {lock_error}");
        }
        return Err(
            crate::localized_error!("backendErrors.vault.operationFailed", "error" => error),
        );
    }
    let manager = app.state::<AppSettingsManager>();
    if manager.is_locked() {
        return Err(vault_error(rcman::Error::ConfigLocked));
    }
    if !is_initial_startup {
        emit_vault_state(manager.inner(), "unlocked");
    }
    Ok(())
}

#[bridge]
pub async fn lock_vault(app: AppHandle) -> Result<(), String> {
    run_vault_operation(&app, AppSettingsManager::lock).await
}

#[bridge]
pub async fn enable_vault(
    app: AppHandle,
    password: String,
    timeout_secs: Option<u64>,
) -> Result<(), String> {
    require_password(&password)?;
    run_vault_operation(&app, move |manager| {
        manager.enable_vault(&password)?;
        if let Some(seconds) = timeout_secs {
            manager.set_vault_lock_timeout((seconds > 0).then(|| Duration::from_secs(seconds)))?;
        }
        Ok(())
    })
    .await
}

#[bridge]
pub async fn disable_vault(app: AppHandle, password: String) -> Result<(), String> {
    require_password(&password)?;
    run_vault_operation(&app, move |manager| manager.disable_vault(&password)).await
}

#[bridge]
pub async fn change_vault_password(
    app: AppHandle,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    require_password(&old_password)?;
    require_password(&new_password)?;
    run_vault_operation(&app, move |manager| {
        manager.change_vault_password(&old_password, &new_password)
    })
    .await
}

#[bridge]
pub async fn set_vault_lock_timeout(
    app: AppHandle,
    timeout_secs: Option<u64>,
) -> Result<(), String> {
    let timeout = timeout_secs
        .filter(|&seconds| seconds > 0)
        .map(Duration::from_secs);
    run_vault_operation(&app, move |manager| manager.set_vault_lock_timeout(timeout)).await?;
    emit_vault_state(app.state::<AppSettingsManager>().inner(), "timeout_changed");
    Ok(())
}

#[bridge]
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

    #[test]
    fn disabled_timeout_is_explicit_in_queries_and_events() {
        let info = VaultInfoResponse {
            enabled: true,
            is_locked: false,
            lock_timeout_secs: None,
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
    fn passwords_reject_empty_values_but_preserve_spaces() {
        assert!(require_password("").is_err());
        assert!(require_password(" password ").is_ok());
    }
}
