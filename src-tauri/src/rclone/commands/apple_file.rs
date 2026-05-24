use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::rclone::backend::BackendManager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppleFileDomain {
    pub domain_id: String,
    pub remote_name: String,
    pub display_name: String,
    pub root_path: String,
    pub active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterAppleFileParams {
    pub remote_name: String,
    pub display_name: Option<String>,
    pub root_path: Option<String>,
}

pub struct AppleFileState {
    pub domains: RwLock<HashMap<String, AppleFileDomain>>,
}

impl Default for AppleFileState {
    fn default() -> Self {
        Self {
            domains: RwLock::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RcloneEndpointInfo {
    pub rc_url: String,
    pub rc_user: Option<String>,
    pub rc_pass: Option<String>,
    pub remotes: Vec<String>,
    pub default_remote: Option<String>,
    pub backend_name: String,
}

impl AppleFileDomain {
    pub fn new(remote_name: &str, display_name: &str, root_path: &str) -> Self {
        Self {
            domain_id: Uuid::new_v4().to_string(),
            remote_name: remote_name.to_string(),
            display_name: display_name.to_string(),
            root_path: root_path.to_string(),
            active: true,
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

pub fn domain_id_for_remote(remote_name: &str) -> String {
    let sanitized: String = remote_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("rman.{}", sanitized)
}

fn shared_container_path() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        Some(std::path::PathBuf::from(format!(
            "{}/Library/Group Containers/group.com.rclone.manager",
            home
        )))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn endpoint_info_path() -> Option<std::path::PathBuf> {
    shared_container_path().map(|p| p.join("rclone-endpoint.json"))
}

#[cfg(target_os = "macos")]
unsafe fn make_fp_domain(
    domain_id: &str,
    display_name: &str,
) -> objc2::rc::Retained<objc2_file_provider::NSFileProviderDomain> {
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    let ns_id = NSString::from_str(domain_id);
    let ns_name = NSString::from_str(display_name);
    let domain: objc2::rc::Retained<objc2_file_provider::NSFileProviderDomain> = msg_send![
        msg_send![class!(NSFileProviderDomain), alloc],
        initWithIdentifier: &*ns_id,
        displayName: &*ns_name,
    ];
    domain
}

pub async fn write_endpoint_info(app: &AppHandle) -> Result<(), String> {
    let backend_manager = app.state::<BackendManager>();
    let backend = backend_manager.get_active().await;
    let backend_name = backend_manager.get_active_name().await;
    let rc_url = backend.url_for("");

    let remotes = crate::rclone::queries::get_remotes(app.clone())
        .await
        .unwrap_or_default();

    let info = RcloneEndpointInfo {
        rc_url: rc_url.to_string(),
        rc_user: backend.username.clone(),
        rc_pass: backend.password.clone(),
        remotes,
        default_remote: None,
        backend_name,
    };

    let json = serde_json::to_string(&info)
        .map_err(|e| format!("Failed to serialize endpoint info: {e}"))?;

    if let Some(path) = endpoint_info_path() {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create shared container dir: {e}"))?;
        }
        tokio::fs::write(&path, &json)
            .await
            .map_err(|e| format!("Failed to write endpoint info: {e}"))?;
        debug!("Wrote rclone endpoint info to {:?}", path);
    } else {
        warn!("No shared container path available, endpoint info not written");
    }

    Ok(())
}

#[tauri::command]
pub async fn register_apple_file_domain(
    app: AppHandle,
    params: RegisterAppleFileParams,
) -> Result<AppleFileDomain, String> {
    info!(
        "Registering FileProvider domain for remote: {}",
        params.remote_name
    );

    let display_name = params
        .display_name
        .unwrap_or_else(|| params.remote_name.clone());
    let root_path = params.root_path.unwrap_or_else(|| String::from("/"));
    let domain = AppleFileDomain::new(&params.remote_name, &display_name, &root_path);

    #[cfg(target_os = "macos")]
    {
        use block2::StackBlock;
        use objc2_file_provider::NSFileProviderManager;

        let domain_id = domain_id_for_remote(&params.remote_name);

        unsafe {
            let fp_domain = make_fp_domain(&domain_id, &display_name);

            let _manager = NSFileProviderManager::defaultManager();
            let block = StackBlock::new(move |error: *mut objc2_foundation::NSError| {
                if !error.is_null() {
                    warn!("Failed to register FileProvider domain '{}'", domain_id);
                } else {
                    info!("FileProvider domain '{}' registered", domain_id);
                }
            });

            NSFileProviderManager::addDomain_completionHandler(&fp_domain, &block);
        }

        write_endpoint_info(&app).await?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        return Err("Apple FileProvider is only supported on macOS".to_string());
    }

    let state = app.state::<AppleFileState>();
    state
        .domains
        .write()
        .await
        .insert(params.remote_name.clone(), domain.clone());

    Ok(domain)
}

#[tauri::command]
pub async fn unregister_apple_file_domain(
    app: AppHandle,
    remote_name: String,
) -> Result<(), String> {
    info!(
        "Unregistering FileProvider domain for remote: {}",
        remote_name
    );

    #[cfg(target_os = "macos")]
    {
        use block2::StackBlock;
        use objc2_file_provider::NSFileProviderManager;

        let domain_id = domain_id_for_remote(&remote_name);

        unsafe {
            let fp_domain = make_fp_domain(&domain_id, &remote_name);

            let _manager = NSFileProviderManager::defaultManager();
            let block = StackBlock::new(move |error: *mut objc2_foundation::NSError| {
                if !error.is_null() {
                    warn!("Failed to remove FileProvider domain '{}'", domain_id);
                } else {
                    info!("FileProvider domain '{}' removed", domain_id);
                }
            });

            NSFileProviderManager::removeDomain_completionHandler(&fp_domain, &block);
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = &app;
        return Err("Apple FileProvider is only supported on macOS".to_string());
    }

    app.state::<AppleFileState>()
        .domains
        .write()
        .await
        .remove(&remote_name);

    Ok(())
}

#[tauri::command]
pub async fn list_apple_file_domains(app: AppHandle) -> Result<Vec<AppleFileDomain>, String> {
    let state = app.state::<AppleFileState>();
    Ok(state.domains.read().await.values().cloned().collect())
}

#[tauri::command]
pub async fn is_apple_file_domain_registered(
    app: AppHandle,
    remote_name: String,
) -> Result<bool, String> {
    Ok(app
        .state::<AppleFileState>()
        .domains
        .read()
        .await
        .contains_key(&remote_name))
}

#[tauri::command]
pub async fn refresh_apple_file_endpoint(app: AppHandle) -> Result<(), String> {
    write_endpoint_info(&app).await
}

#[tauri::command]
pub async fn signal_apple_file_change(_app: AppHandle, remote_name: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use block2::StackBlock;
        use objc2::msg_send;
        use objc2_file_provider::NSFileProviderManager;
        use objc2_foundation::NSString;

        unsafe {
            let manager = NSFileProviderManager::defaultManager();
            let working_set_id =
                NSString::from_str("NSFileProviderWorkingSetContainerItemIdentifier");

            let block = StackBlock::new(move |error: *mut objc2::runtime::AnyObject| {
                if !error.is_null() {
                    warn!("Failed to signal enumerator change for '{}'", remote_name);
                } else {
                    debug!("Signaled enumerator change for '{}'", remote_name);
                }
            });

            let _: () = msg_send![
                &*manager,
                signalEnumeratorForContainerItemIdentifier: &*working_set_id,
                completionHandler: &*block,
            ];
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_id_alphanumeric_passthrough() {
        assert_eq!(domain_id_for_remote("myRemote1"), "rman.myRemote1");
    }

    #[test]
    fn domain_id_sanitizes_special_chars() {
        let id = domain_id_for_remote("my remote/name");
        assert_eq!(id, "rman.my_remote_name");
    }

    #[test]
    fn domain_id_allows_hyphen_and_underscore() {
        assert_eq!(domain_id_for_remote("my-remote_1"), "rman.my-remote_1");
    }

    #[test]
    fn domain_id_sanitizes_colon() {
        assert_eq!(domain_id_for_remote("s3:"), "rman.s3_");
    }
}
