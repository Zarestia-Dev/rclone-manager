use crate::core::settings::AppSettingsManager;
use log::{debug, error, info};

/// Migrates legacy keyring credentials to the new format.
///
/// This is a synchronous operation that accesses the OS keyring via D-Bus on Linux.
/// It should be called from an asynchronous context (like `initialization()`) to avoid
/// blocking the UI thread during startup.
pub fn migrate_keyring_credentials(manager: &AppSettingsManager) {
    use rcman::CredentialManager;
    let service_name = env!("CARGO_PKG_NAME");
    let creds = CredentialManager::new(service_name);

    let connections_sub = match manager.sub_settings("connections") {
        Ok(sub) => sub,
        Err(e) => {
            debug!("Skipping keyring migration: connections sub-settings not found ({e})");
            return;
        }
    };

    // We need to iterate over all connection names.
    // Since we don't have a direct list of keys in rcman sub-settings yet without loading values,
    // we'll try to get all values.
    let all_connections = match connections_sub.get_all_values() {
        Ok(all) => all,
        Err(e) => {
            debug!("Skipping keyring migration: failed to load connections ({e})");
            return;
        }
    };

    for (name, _) in all_connections {
        // Password field
        let legacy_pass_key = format!("backend:{name}:password");
        let new_pass_key = format!("sub.connections.{name}.password");

        if creds.exists(&legacy_pass_key) {
            if creds.exists(&new_pass_key) {
                debug!("Cleaning up legacy password for '{name}' (already migrated)");
                let _ = creds.remove(&legacy_pass_key);
            } else if let Ok(Some(secret)) = creds.get(&legacy_pass_key) {
                info!("🔐 Migrating legacy password for '{name}'");
                if let Err(e) = creds.store(&new_pass_key, &secret) {
                    error!("Failed to migrate password for '{name}': {e}");
                } else {
                    let _ = creds.remove(&legacy_pass_key);
                }
            }
        }

        // Config Password field
        let legacy_conf_key = format!("backend:{name}:config_password");
        let new_conf_key = format!("sub.connections.{name}.config_password");

        if creds.exists(&legacy_conf_key) {
            if creds.exists(&new_conf_key) {
                debug!("Cleaning up legacy config_password for '{name}' (already migrated)");
                let _ = creds.remove(&legacy_conf_key);
            } else if let Ok(Some(secret)) = creds.get(&legacy_conf_key) {
                info!("🔐 Migrating legacy config_password for '{name}'");
                if let Err(e) = creds.store(&new_conf_key, &secret) {
                    error!("Failed to migrate config_password for '{name}': {e}");
                } else {
                    let _ = creds.remove(&legacy_conf_key);
                }
            }
        }
    }
}
