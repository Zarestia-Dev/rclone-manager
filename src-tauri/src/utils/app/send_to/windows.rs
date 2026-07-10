use std::path::{Path, PathBuf};

struct WindowsPaths {
    send_to: PathBuf,
}

impl WindowsPaths {
    fn new() -> Result<Self, String> {
        let appdata = std::env::var("APPDATA")
            .map_err(|_| "Could not find APPDATA environment variable".to_string())?;
        Ok(Self {
            send_to: PathBuf::from(appdata)
                .join("Microsoft")
                .join("Windows")
                .join("SendTo"),
        })
    }
}

fn register_context_menu_entry(
    hkcu: &winreg::RegKey,
    root_path: &str,
    name: &str,
    label: &str,
    icon_path: &str,
    command: &str,
) -> Result<(), String> {
    let parent_path = format!(r"{root_path}\shell\RCloneManager");

    let (parent_key, _) = hkcu
        .create_subkey(&parent_path)
        .map_err(|e| format!("Failed creating registry key '{parent_path}': {e}"))?;
    parent_key
        .set_value("MUIVerb", &"RClone Manager")
        .map_err(|e| format!("Failed creating registry key '{parent_path}': {e}"))?;
    parent_key
        .set_value("Icon", &icon_path)
        .map_err(|e| format!("Failed creating registry key '{parent_path}': {e}"))?;
    parent_key
        .set_value("SubCommands", &"")
        .map_err(|e| format!("Failed creating registry key '{parent_path}': {e}"))?;

    let (shell_key, _) = parent_key
        .create_subkey("shell")
        .map_err(|e| format!("Failed creating registry key '{parent_path}\\shell': {e}"))?;
    let (item_key, _) = shell_key
        .create_subkey(name)
        .map_err(|e| format!("Failed creating registry key '{parent_path}\\shell\\{name}': {e}"))?;
    item_key
        .set_value("", &label)
        .map_err(|e| format!("Failed creating registry key '{parent_path}\\shell\\{name}': {e}"))?;

    let (cmd_key, _) = item_key.create_subkey("command").map_err(|e| {
        format!("Failed creating registry key '{parent_path}\\shell\\{name}\\command': {e}")
    })?;
    cmd_key.set_value("", &command).map_err(|e| {
        format!("Failed creating registry key '{parent_path}\\shell\\{name}\\command': {e}")
    })
}

fn unregister_context_menu_entry(hkcu: &winreg::RegKey, root_path: &str, name: &str) {
    use winreg::enums::KEY_ALL_ACCESS;

    let parent_path = format!(r"{root_path}\shell\RCloneManager");
    let Ok(parent_key) = hkcu.open_subkey_with_flags(&parent_path, KEY_ALL_ACCESS) else {
        return;
    };
    let Ok(shell_key) = parent_key.open_subkey_with_flags("shell", KEY_ALL_ACCESS) else {
        return;
    };

    let _ = shell_key.delete_subkey(name);

    if shell_key.enum_keys().count() == 0 {
        drop(shell_key);
        drop(parent_key);
        let _ = hkcu.delete_subkey_all(&parent_path);
    }
}

pub async fn register(
    remote: &str,
    path_val: &str,
    name: &str,
    current_exe: &Path,
) -> Result<(), String> {
    let paths = WindowsPaths::new()?;
    std::fs::create_dir_all(&paths.send_to)
        .map_err(|e| format!("Failed to create SendTo directory: {e}"))?;

    let shortcut_path = paths.send_to.join(format!("{name}.lnk"));
    let arguments = format!("--send-to-remote \"{remote}\" --send-to-path \"{path_val}\"");

    let target_str = current_exe.to_string_lossy();
    let shortcut_str = shortcut_path.to_string_lossy();

    let shortcut_escaped = shortcut_str.replace('\'', "''");
    let target_escaped = target_str.replace('\'', "''");
    let arguments_escaped = arguments.replace('\'', "''");

    // 1. File ("*") and Directory context menu entries
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_CURRENT_USER;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let context_menu_command = format!(
            "\"{target_str}\" --send-to-remote \"{remote}\" --send-to-path \"{path_val}\" \"%1\""
        );
        let label = if path_val.is_empty() {
            format!("Upload to {remote}")
        } else {
            format!("Upload to {remote}/{}", path_val.trim_start_matches('/'))
        };

        for root_path in [r"Software\Classes\*", r"Software\Classes\Directory"] {
            register_context_menu_entry(
                &hkcu,
                root_path,
                name,
                &label,
                target_str.as_ref(),
                &context_menu_command,
            )?;
        }
    }

    // 2. Create SendTo shortcut via PowerShell script execution
    let powershell_cmd = format!(
        "$WshShell = New-Object -ComObject WScript.Shell; \
         $Shortcut = $WshShell.CreateShortcut('{shortcut_escaped}'); \
         $Shortcut.TargetPath = '{target_escaped}'; \
         $Shortcut.Arguments = '{arguments_escaped}'; \
         $Shortcut.IconLocation = '{target_escaped}'; \
         $Shortcut.Save()"
    );

    let powershell_executable = if which::which("powershell").is_ok() {
        "powershell"
    } else if which::which("pwsh").is_ok() {
        "pwsh"
    } else {
        return Err(
            "Neither 'powershell' nor 'pwsh' command line tools could be found on this system."
                .to_string(),
        );
    };

    let output = crate::utils::process::command::Command::new(powershell_executable)
        .args(["-NoProfile", "-Command", &powershell_cmd])
        .output()
        .await
        .map_err(|e| format!("Failed to run PowerShell/pwsh to create shortcut: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("PowerShell shortcut creation failed: {stderr}"));
    }

    Ok(())
}

pub fn unregister(name: &str) -> Result<(), String> {
    let paths = WindowsPaths::new()?;
    let shortcut_path = paths.send_to.join(format!("{name}.lnk"));
    if shortcut_path.exists() {
        let _ = std::fs::remove_file(shortcut_path);
    }

    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    for root_path in [r"Software\Classes\*", r"Software\Classes\Directory"] {
        unregister_context_menu_entry(&hkcu, root_path, name);
    }

    Ok(())
}

pub fn is_registered(name: &str) -> Result<bool, String> {
    let paths = WindowsPaths::new()?;
    if paths.send_to.join(format!("{name}.lnk")).exists() {
        return Ok(true);
    }

    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    let registered_under = |root_path: &str| {
        hkcu.open_subkey(format!(r"{root_path}\shell\RCloneManager\shell\{name}"))
            .is_ok()
    };

    Ok(registered_under(r"Software\Classes\*") || registered_under(r"Software\Classes\Directory"))
}
