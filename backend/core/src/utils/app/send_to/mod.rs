pub mod common;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "macos")]
pub mod macos;

use common::get_sanitized_name;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
use windows as platform;

pub async fn register_send_to(
    app: crate::context::AppHandle,
    remote: String,
    path: Option<String>,
) -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Failed to get current executable path: {e}"))?;
    let name = get_sanitized_name(&remote, path.as_deref(), app.product().display_name);
    let path_val = path.as_deref().unwrap_or("");

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    platform::register(&remote, path_val, &name, &current_exe, app.product()).await?;

    Ok(())
}

pub async fn unregister_send_to(
    app: crate::context::AppHandle,
    remote: String,
    path: Option<String>,
) -> Result<(), String> {
    let name = get_sanitized_name(&remote, path.as_deref(), app.product().display_name);

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    platform::unregister(&name, app.product())?;

    Ok(())
}

pub async fn is_send_to_registered(
    app: crate::context::AppHandle,
    remote: String,
    path: Option<String>,
) -> Result<bool, String> {
    let name = get_sanitized_name(&remote, path.as_deref(), app.product().display_name);

    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        platform::is_registered(&name, app.product())
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn missing_shortcut_is_not_registered() {
        let app = crate::context::AppHandle::default();
        let remote = format!("missing-{}", uuid::Uuid::new_v4());
        for path in [None, Some(String::new()), Some("/folder:with?chars".into())] {
            assert!(
                !is_send_to_registered(app.clone(), remote.clone(), path)
                    .await
                    .unwrap()
            );
        }
    }
}
