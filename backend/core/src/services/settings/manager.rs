use std::path::Path;

use crate::services::settings::AppSettingsManager;
use crate::services::settings::remote::manager::migrate_to_multi_profile;
use crate::services::settings::schema::AppSettings;

/// Creates a new `AppSettingsManager` with all necessary sub-settings.
pub fn create_settings_manager(config_dir: &Path) -> Result<AppSettingsManager, String> {
    let mut builder = rcman::SettingsManager::builder("rclone-manager", env!("CARGO_PKG_VERSION"))
        .with_config_dir(config_dir)
        .with_env_credentials()
        .with_vault()
        .with_schema::<AppSettings>()
        .with_sub_settings(
            rcman::SubSettingsConfig::new("remotes")
                .with_profiles()
                .with_migrator(migrate_to_multi_profile),
        )
        .with_sub_settings(rcman::SubSettingsConfig::singlefile("backend").with_profiles())
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile("connections")
                .with_schema::<crate::rclone::backend::types::Backend>(),
        )
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile("alerts/rules")
                .with_schema::<crate::services::alerts::types::AlertRule>(),
        )
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile("alerts/actions")
                .with_schema::<crate::services::alerts::types::AlertAction>(),
        )
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile(crate::utils::constants::SUB_QUICK_RUNS)
                .with_profiles(),
        )
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile(crate::utils::constants::SUB_WORKFLOWS)
                .with_profiles(),
        )
        .with_sub_settings(
            rcman::SubSettingsConfig::singlefile(crate::utils::constants::SUB_TEMPLATES)
                .with_schema::<crate::services::settings::schema::UserPresetTemplate>(),
        );

    let password_source = vault_password_source(
        std::env::var("RCLONE_MANAGER_VAULT_PASSWORD"),
        std::env::var_os("RCLONE_MANAGER_VAULT_PASSWORD_FILE"),
    )?;
    if let Some(source) = password_source {
        builder = builder.with_vault_password_source(source);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create rcman settings manager: {e}"))
}

/// Select the startup vault password source. Empty variables count as unset, so
/// Compose entries like `RCLONE_MANAGER_VAULT_PASSWORD=${VAULT_PASSWORD}` do not
/// abort startup when the host variable is missing.
fn vault_password_source(
    password: Result<String, std::env::VarError>,
    file: Option<std::ffi::OsString>,
) -> Result<Option<rcman::SecretPasswordSource>, String> {
    match password {
        Ok(password) if !password.is_empty() => {
            return Ok(Some(rcman::SecretPasswordSource::provided(password)));
        }
        Ok(_) | Err(std::env::VarError::NotPresent) => {}
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err("Vault password environment variable must contain valid Unicode".into());
        }
    }
    Ok(file
        .filter(|path| !path.is_empty())
        .map(rcman::SecretPasswordSource::file))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::VarError;

    #[test]
    fn existing_quick_runs_and_workflows_become_the_local_backends_profile() {
        use crate::utils::constants::{LOCAL_BACKEND_PROFILE, SUB_QUICK_RUNS, SUB_WORKFLOWS};
        let directory = tempfile::tempdir().unwrap();
        let legacy = rcman::SettingsManager::builder("migration-test", "1")
            .with_config_dir(directory.path())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(SUB_QUICK_RUNS))
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(SUB_WORKFLOWS))
            .build()
            .unwrap();
        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            legacy
                .sub_settings(section)
                .unwrap()
                .set("kept", &serde_json::json!({"name": section}))
                .unwrap();
        }
        drop(legacy);

        let manager = create_settings_manager(directory.path()).unwrap();
        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            let sub = manager.sub_settings(section).unwrap();
            assert_eq!(sub.list().unwrap(), ["kept"]);
            assert_eq!(
                sub.profiles().unwrap().active().unwrap(),
                LOCAL_BACKEND_PROFILE
            );
        }
    }

    /// An install from before quick runs and workflows had profiles, with the vault enabled.
    fn encrypted_legacy_install(directory: &Path) {
        use crate::utils::constants::{SUB_QUICK_RUNS, SUB_WORKFLOWS};
        let legacy = rcman::SettingsManager::builder("rclone-manager", "1")
            .with_config_dir(directory)
            .with_vault_password("password")
            .with_vault_preset(rcman::Argon2Preset::Fast)
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(SUB_QUICK_RUNS))
            .with_sub_settings(rcman::SubSettingsConfig::singlefile(SUB_WORKFLOWS))
            .build()
            .unwrap();
        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            legacy
                .sub_settings(section)
                .unwrap()
                .set("kept", &serde_json::json!({"name": section}))
                .unwrap();
        }
    }

    #[test]
    fn a_locked_vault_starts_and_unlocking_moves_quick_runs_and_workflows_into_the_profile() {
        use crate::utils::constants::{LOCAL_BACKEND_PROFILE, SUB_QUICK_RUNS, SUB_WORKFLOWS};
        let directory = tempfile::tempdir().unwrap();
        encrypted_legacy_install(directory.path());

        let manager = create_settings_manager(directory.path()).unwrap();
        assert!(directory.path().join("quick_runs.json").is_file());
        assert!(directory.path().join("workflows.json").is_file());

        manager.unlock("password").unwrap();
        for section in [SUB_QUICK_RUNS, SUB_WORKFLOWS] {
            let sub = manager.sub_settings(section).unwrap();
            assert_eq!(sub.list().unwrap(), ["kept"]);
            assert_eq!(sub.get_value("kept").unwrap()["name"], section);
            assert_eq!(
                sub.profiles().unwrap().active().unwrap(),
                LOCAL_BACKEND_PROFILE
            );
            assert!(!directory.path().join(format!("{section}.json")).exists());
        }
    }

    #[test]
    fn password_variable_wins_over_file() {
        let source = vault_password_source(Ok("pw".into()), Some("/run/secrets/v".into()));
        assert_eq!(
            source,
            Ok(Some(rcman::SecretPasswordSource::provided("pw")))
        );
    }

    #[test]
    fn empty_or_missing_variables_are_ignored() {
        assert_eq!(
            vault_password_source(Err(VarError::NotPresent), None),
            Ok(None)
        );
        assert_eq!(vault_password_source(Ok(String::new()), None), Ok(None));
        assert_eq!(
            vault_password_source(Ok(String::new()), Some(std::ffi::OsString::new())),
            Ok(None)
        );
    }

    #[test]
    fn password_file_is_used_when_password_is_unset() {
        let source =
            vault_password_source(Err(VarError::NotPresent), Some("/run/secrets/v".into()));
        assert_eq!(
            source,
            Ok(Some(rcman::SecretPasswordSource::file("/run/secrets/v")))
        );
    }

    #[test]
    fn non_unicode_password_is_rejected() {
        let invalid = VarError::NotUnicode(std::ffi::OsString::new());
        assert!(vault_password_source(Err(invalid), None).is_err());
    }
}
