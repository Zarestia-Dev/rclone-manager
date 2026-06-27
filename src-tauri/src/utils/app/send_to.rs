use tauri::command;

const INVALID_NAME_CHARS: &str = r#"<>:"/\|?*"#;

fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if INVALID_NAME_CHARS.contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect()
}

fn get_sanitized_name(remote: &str, path: Option<&str>) -> String {
    let path_suffix = path
        .filter(|p| !p.is_empty() && *p != "/")
        .map(|p| {
            format!(
                " - {}",
                p.trim_start_matches('/').replace(['/', '\\'], " - ")
            )
        })
        .unwrap_or_default();

    sanitize_name(&format!("{remote}{path_suffix} (RClone Manager)"))
}

fn apply_template(template: &str, replacements: &[(&str, &str)]) -> String {
    let mut content = template.to_string();
    for &(key, value) in replacements {
        content = content.replace(&format!("{{{key}}}"), value);
    }
    content
}

#[cfg(target_os = "windows")]
fn get_send_to_dir() -> Result<std::path::PathBuf, String> {
    let appdata = std::env::var("APPDATA")
        .map_err(|_| "Could not find APPDATA environment variable".to_string())?;
    Ok(std::path::PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("SendTo"))
}

#[cfg(unix)]
fn get_home_dir() -> Result<std::path::PathBuf, String> {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .map_err(|_| "Could not find HOME environment variable".to_string())
}

#[cfg(target_os = "macos")]
fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "linux")]
fn write_executable(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    std::fs::write(path, content)?;
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms)
}

#[command]
pub async fn register_send_to(remote: String, path: Option<String>) -> Result<(), String> {
    let current_exe = std::env::current_exe()
        .map_err(|e| format!("Failed to get current executable path: {e}"))?;
    let name = get_sanitized_name(&remote, path.as_deref());

    #[cfg(target_os = "windows")]
    {
        let send_to_dir = get_send_to_dir()?;
        std::fs::create_dir_all(&send_to_dir)
            .map_err(|e| format!("Failed to create SendTo directory: {e}"))?;

        let shortcut_path = send_to_dir.join(format!("{name}.lnk"));
        let path_val = path.as_deref().unwrap_or("");
        let arguments = format!("--send-to-remote \"{remote}\" --send-to-path \"{path_val}\"");

        let target_str = current_exe.to_string_lossy();
        let shortcut_str = shortcut_path.to_string_lossy();

        let shortcut_escaped = shortcut_str.replace('\'', "''");
        let target_escaped = target_str.replace('\'', "''");
        let arguments_escaped = arguments.replace('\'', "''");

        // 1. Create file (*) context menu keys
        {
            use winreg::RegKey;
            use winreg::enums::*;
            let hkcu = RegKey::predefined(HKEY_CURRENT_USER);
            let (parent_key, _) = hkcu
                .create_subkey(r"Software\Classes\*\shell\RCloneManager")
                .map_err(|e| format!("Failed to create file context menu registry key: {e}"))?;
            parent_key
                .set_value("MUIVerb", &"RClone Manager")
                .map_err(|e| format!("Failed to set file context menu MUIVerb: {e}"))?;
            parent_key
                .set_value("Icon", &target_str.as_ref())
                .map_err(|e| format!("Failed to set file context menu Icon: {e}"))?;

            let (shell_key, _) = parent_key
                .create_subkey("shell")
                .map_err(|e| format!("Failed to create file context menu shell key: {e}"))?;
            let (item_key, _) = shell_key
                .create_subkey(&name)
                .map_err(|e| format!("Failed to create file context menu item key: {e}"))?;
            item_key
                .set_value("", &format!("Upload to {remote}"))
                .map_err(|e| format!("Failed to set file context menu item label: {e}"))?;

            let (cmd_key, _) = item_key
                .create_subkey("command")
                .map_err(|e| format!("Failed to create file context menu command key: {e}"))?;
            cmd_key.set_value("", &format!("\"{target_str}\" --send-to-remote \"{remote}\" --send-to-path \"{path_val}\" \"%1\""))
                .map_err(|e| format!("Failed to set file context menu command value: {e}"))?;
        }

        // 2. Create directory (folders) context menu keys
        {
            use winreg::RegKey;
            use winreg::enums::*;
            let hkcu = RegKey::predefined(HKEY_CURRENT_USER);
            let (parent_key, _) = hkcu
                .create_subkey(r"Software\Classes\Directory\shell\RCloneManager")
                .map_err(|e| {
                    format!("Failed to create directory context menu registry key: {e}")
                })?;
            parent_key
                .set_value("MUIVerb", &"RClone Manager")
                .map_err(|e| format!("Failed to set directory context menu MUIVerb: {e}"))?;
            parent_key
                .set_value("Icon", &target_str.as_ref())
                .map_err(|e| format!("Failed to set directory context menu Icon: {e}"))?;

            let (shell_key, _) = parent_key
                .create_subkey("shell")
                .map_err(|e| format!("Failed to create directory context menu shell key: {e}"))?;
            let (item_key, _) = shell_key
                .create_subkey(&name)
                .map_err(|e| format!("Failed to create directory context menu item key: {e}"))?;
            item_key
                .set_value("", &format!("Upload to {remote}"))
                .map_err(|e| format!("Failed to set directory context menu item label: {e}"))?;

            let (cmd_key, _) = item_key
                .create_subkey("command")
                .map_err(|e| format!("Failed to create directory context menu command key: {e}"))?;
            cmd_key.set_value("", &format!("\"{target_str}\" --send-to-remote \"{remote}\" --send-to-path \"{path_val}\" \"%1\""))
                .map_err(|e| format!("Failed to set directory context menu command value: {e}"))?;
        }

        // 3. Create SendTo shortcut via PowerShell script execution
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
    }

    #[cfg(target_os = "linux")]
    {
        let home = get_home_dir()?;
        let current_exe_str = current_exe.to_string_lossy();
        let exec_path = current_exe_str.as_ref();
        let path_str = path.as_deref().unwrap_or("");

        // 1. Nautilus script
        let nautilus_dir = home.join(".local/share/nautilus/scripts");
        if std::fs::create_dir_all(&nautilus_dir).is_ok() {
            let content = apply_template(
                include_str!("../../../resources/send_to/nautilus_script.sh"),
                &[
                    ("exec_path", exec_path),
                    ("remote", &remote),
                    ("path", path_str),
                ],
            );
            let _ = write_executable(&nautilus_dir.join(&name), &content);
        }

        // 2. Nautilus Python extension
        let nautilus_py_dir = home.join(".local/share/nautilus-python/extensions");
        if std::fs::create_dir_all(&nautilus_py_dir).is_ok() {
            let uuid = uuid::Uuid::new_v4().to_string().replace('-', "");
            let class_name = format!("RCloneManagerExtension_{uuid}");
            let content = apply_template(
                include_str!("../../../resources/send_to/nautilus_extension.py"),
                &[
                    ("class_name", class_name.as_str()),
                    ("exec_path", exec_path),
                    ("remote", &remote),
                    ("path", path_str),
                    ("uuid", uuid.as_str()),
                    ("name", &name),
                ],
            );
            let _ = std::fs::write(nautilus_py_dir.join(format!("{name}.py")), content);
        }

        // 3. Dolphin
        let dolphin_dir = home.join(".local/share/kio/servicemenus");
        if std::fs::create_dir_all(&dolphin_dir).is_ok() {
            let content = apply_template(
                include_str!("../../../resources/send_to/dolphin_action.desktop"),
                &[
                    ("name", &name),
                    ("exec_path", exec_path),
                    ("remote", &remote),
                    ("path", path_str),
                ],
            );
            let _ = write_executable(&dolphin_dir.join(format!("{name}.desktop")), &content);
        }

        // 4. Nemo
        let nemo_dir = home.join(".local/share/nemo/actions");
        if std::fs::create_dir_all(&nemo_dir).is_ok() {
            let content = apply_template(
                include_str!("../../../resources/send_to/nemo_action.nemo_action"),
                &[
                    ("name", &name),
                    ("exec_path", exec_path),
                    ("remote", &remote),
                    ("path", path_str),
                ],
            );
            let _ = write_executable(&nemo_dir.join(format!("{name}.nemo_action")), &content);
        }
    }

    #[cfg(target_os = "macos")]
    {
        let home = get_home_dir()?;
        let workflow_dir = home.join(format!("Library/Services/{name}.workflow"));
        let contents_dir = workflow_dir.join("Contents");
        std::fs::create_dir_all(&contents_dir)
            .map_err(|e| format!("Failed to create workflow bundle directories: {e}"))?;

        // 1. Info.plist
        let info_uuid = uuid::Uuid::new_v4().to_string().replace('-', "");
        let escaped_name = escape_xml(&name);
        let info_content = apply_template(
            include_str!("../../../resources/send_to/macos_info.plist"),
            &[
                ("uuid", info_uuid.as_str()),
                ("name", escaped_name.as_str()),
            ],
        );
        std::fs::write(contents_dir.join("Info.plist"), info_content)
            .map_err(|e| format!("Failed to write Info.plist: {e}"))?;

        // 2. document.wflow
        let current_exe_str = current_exe.to_string_lossy();
        let path_str = path.as_deref().unwrap_or("");
        let cmd_string = format!(
            "exec \"{current_exe_str}\" --send-to-remote \"{remote}\" --send-to-path \"{path_str}\" \"$@\""
        );
        let cmd_string_escaped = escape_xml(&cmd_string);
        let input_uuid = uuid::Uuid::new_v4().to_string().to_uppercase();
        let output_uuid = uuid::Uuid::new_v4().to_string().to_uppercase();
        let action_uuid = uuid::Uuid::new_v4().to_string().to_uppercase();

        let doc_content = apply_template(
            include_str!("../../../resources/send_to/macos_document.wflow"),
            &[
                ("cmd_string", cmd_string_escaped.as_str()),
                ("input_uuid", input_uuid.as_str()),
                ("output_uuid", output_uuid.as_str()),
                ("action_uuid", action_uuid.as_str()),
            ],
        );
        std::fs::write(contents_dir.join("document.wflow"), doc_content)
            .map_err(|e| format!("Failed to write document.wflow: {e}"))?;
    }

    Ok(())
}

#[command]
pub async fn unregister_send_to(remote: String, path: Option<String>) -> Result<(), String> {
    let name = get_sanitized_name(&remote, path.as_deref());

    #[cfg(target_os = "windows")]
    {
        let send_to_dir = get_send_to_dir()?;
        let shortcut_path = send_to_dir.join(format!("{name}.lnk"));
        if shortcut_path.exists() {
            let _ = std::fs::remove_file(shortcut_path);
        }

        // Native Registry Cleanups
        {
            use winreg::RegKey;
            use winreg::enums::*;
            let hkcu = RegKey::predefined(HKEY_CURRENT_USER);

            // 1. Files context menu cleanup
            if let Ok(parent_key) = hkcu
                .open_subkey_with_flags(r"Software\Classes\*\shell\RCloneManager", KEY_ALL_ACCESS)
            {
                if let Ok(shell_key) = parent_key.open_subkey_with_flags("shell", KEY_ALL_ACCESS) {
                    let _ = shell_key.delete_subkey(&name);

                    // Check if shell key is now empty, if so delete parent RCloneManager key
                    let subkey_count = shell_key.enum_keys().count();
                    if subkey_count == 0 {
                        drop(shell_key);
                        drop(parent_key);
                        let _ = hkcu.delete_subkey_all(r"Software\Classes\*\shell\RCloneManager");
                    }
                }
            }

            // 2. Directory context menu cleanup
            if let Ok(parent_key) = hkcu.open_subkey_with_flags(
                r"Software\Classes\Directory\shell\RCloneManager",
                KEY_ALL_ACCESS,
            ) {
                if let Ok(shell_key) = parent_key.open_subkey_with_flags("shell", KEY_ALL_ACCESS) {
                    let _ = shell_key.delete_subkey(&name);

                    // Check if shell key is now empty, if so delete parent RCloneManager key
                    let subkey_count = shell_key.enum_keys().count();
                    if subkey_count == 0 {
                        drop(shell_key);
                        drop(parent_key);
                        let _ = hkcu
                            .delete_subkey_all(r"Software\Classes\Directory\shell\RCloneManager");
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let home = get_home_dir()?;

        let _ = std::fs::remove_file(home.join(".local/share/nautilus/scripts").join(&name));
        let _ = std::fs::remove_file(
            home.join(".local/share/nautilus-python/extensions")
                .join(format!("{name}.py")),
        );
        let _ = std::fs::remove_file(
            home.join(".local/share/kio/servicemenus")
                .join(format!("{name}.desktop")),
        );
        let _ = std::fs::remove_file(
            home.join(".local/share/nemo/actions")
                .join(format!("{name}.nemo_action")),
        );
    }

    #[cfg(target_os = "macos")]
    {
        let home = get_home_dir()?;
        let workflow_dir = home.join(format!("Library/Services/{name}.workflow"));
        if workflow_dir.exists() {
            std::fs::remove_dir_all(workflow_dir)
                .map_err(|e| format!("Failed to delete workflow bundle: {e}"))?;
        }
    }

    Ok(())
}

#[command]
pub async fn is_send_to_registered(remote: String, path: Option<String>) -> Result<bool, String> {
    let name = get_sanitized_name(&remote, path.as_deref());

    #[cfg(target_os = "windows")]
    {
        let send_to_dir = get_send_to_dir()?;
        Ok(send_to_dir.join(format!("{name}.lnk")).exists())
    }

    #[cfg(target_os = "linux")]
    {
        let home = get_home_dir()?;

        let nautilus_path = home.join(".local/share/nautilus/scripts").join(&name);
        let nautilus_py_path = home
            .join(".local/share/nautilus-python/extensions")
            .join(format!("{name}.py"));
        let dolphin_path = home
            .join(".local/share/kio/servicemenus")
            .join(format!("{name}.desktop"));
        let nemo_path = home
            .join(".local/share/nemo/actions")
            .join(format!("{name}.nemo_action"));

        Ok(nautilus_path.exists()
            || nautilus_py_path.exists()
            || dolphin_path.exists()
            || nemo_path.exists())
    }

    #[cfg(target_os = "macos")]
    {
        let home = get_home_dir()?;
        Ok(home
            .join(format!("Library/Services/{name}.workflow"))
            .exists())
    }
}
