//! The rclone config password lives in this process's environment, where both a
//! spawned `rclone` and in-process librclone read it.
use crate::services::settings::AppSettingsManager;
use crate::utils::constants::LOCAL_BACKEND_NAME;
use log::{debug, info};
use std::collections::HashMap;

pub const CONFIG_PASS_VAR: &str = "RCLONE_CONFIG_PASS";

/// Loads the Local backend's stored config password, if it has one.
pub fn load_stored_config_password(manager: &AppSettingsManager) {
    let local = manager
        .sub_settings("connections")
        .map_err(|e| format!("Failed to access connections sub-settings: {e}"))
        .and_then(|connections| {
            connections
                .get_value(LOCAL_BACKEND_NAME)
                .map_err(|e| format!("Failed to load Local connection settings: {e}"))
        });
    match local {
        Ok(local) => match local.get("config_password").and_then(|v| v.as_str()) {
            Some(password) if !password.is_empty() => {
                set_config_password(password);
                info!("Loaded the stored rclone config password");
            }
            _ => debug!("No stored credentials found during initialization"),
        },
        Err(e) => debug!("{e}"),
    }
}

#[allow(clippy::disallowed_methods)]
pub fn set_config_password(password: &str) {
    unsafe {
        std::env::set_var(CONFIG_PASS_VAR, password);
    }
}

pub fn clear_config_password() {
    unsafe {
        std::env::remove_var(CONFIG_PASS_VAR);
    }
}

/// Every `RCLONE_*` variable rclone should inherit.
pub fn vars() -> HashMap<String, String> {
    std::env::vars()
        .filter(|(key, _)| key.starts_with("RCLONE_"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::disallowed_methods)]
    fn only_rclone_variables_are_passed_on() {
        // A name no other test or process uses, so parallel tests cannot interfere.
        unsafe {
            std::env::set_var("RCLONE_ENV_TEST_ONLY_VAR", "x");
            std::env::set_var("NOT_RCLONE_ENV_TEST_ONLY_VAR", "y");
        }
        let vars = vars();
        assert_eq!(
            vars.get("RCLONE_ENV_TEST_ONLY_VAR").map(String::as_str),
            Some("x")
        );
        assert!(!vars.contains_key("NOT_RCLONE_ENV_TEST_ONLY_VAR"));
    }
}
