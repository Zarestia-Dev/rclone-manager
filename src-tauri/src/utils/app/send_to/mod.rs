use tauri::command;

pub mod common;

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "macos")]
pub mod macos;

use common::get_sanitized_name;

#[command]
pub async fn register_send_to(remote: String, path: Option<String>) -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Failed to get current executable path: {e}"))?;
    let name = get_sanitized_name(&remote, path.as_deref());
    let path_val = path.as_deref().unwrap_or("");

    #[cfg(target_os = "windows")]
    {
        windows::register(&remote, path_val, &name, &current_exe).await?;
    }

    #[cfg(target_os = "linux")]
    {
        linux::register(&remote, path_val, &name, &current_exe)?;
    }

    #[cfg(target_os = "macos")]
    {
        macos::register(&remote, path_val, &name, &current_exe)?;
    }

    Ok(())
}

#[command]
pub async fn unregister_send_to(remote: String, path: Option<String>) -> Result<(), String> {
    let name = get_sanitized_name(&remote, path.as_deref());

    #[cfg(target_os = "windows")]
    {
        windows::unregister(&name)?;
    }

    #[cfg(target_os = "linux")]
    {
        linux::unregister(&name)?;
    }

    #[cfg(target_os = "macos")]
    {
        macos::unregister(&name)?;
    }

    Ok(())
}

#[command]
pub async fn is_send_to_registered(remote: String, path: Option<String>) -> Result<bool, String> {
    let name = get_sanitized_name(&remote, path.as_deref());

    #[cfg(target_os = "windows")]
    {
        windows::is_registered(&name)
    }

    #[cfg(target_os = "linux")]
    {
        linux::is_registered(&name)
    }

    #[cfg(target_os = "macos")]
    {
        macos::is_registered(&name)
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    Ok(false)
}
