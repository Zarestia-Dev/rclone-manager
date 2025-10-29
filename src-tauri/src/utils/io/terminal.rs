use log::{error, info, warn};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use crate::utils::{
    logging::log::log_operation,
    types::all_types::{LogLevel, RcloneState},
};

#[tauri::command]
pub async fn open_terminal_config(
    app: AppHandle,
    remote_name: Option<String>,
) -> Result<(), String> {
    // Step 1: Build the command as a vector of strings (your new logic).
    let rclone_binary_path = crate::core::check_binaries::read_rclone_path(&app);
    let mut command_parts: Vec<String> = vec![rclone_binary_path.to_string_lossy().to_string()];

    // Add config file path if specified in state
    let rclone_state = app.state::<RcloneState>();
    let config_file = rclone_state.rclone_config_file.read().unwrap().clone();
    if !config_file.is_empty() {
        command_parts.push("--config".to_string());
        command_parts.push(config_file);
    }

    // Add the specific "config" or "config edit <name>" parts
    match &remote_name {
        Some(name) => {
            command_parts.push("config".to_string());
            command_parts.push("edit".to_string());
            command_parts.push(name.clone());
        }
        _ => {
            command_parts.push("config".to_string());
        }
    }

    // Step 2: Convert the vector into a single, shell-safe string.
    // This quotes any part that contains spaces (like "C:\Program Files\rclone.exe").
    let rclone_command_string = command_parts
        .iter()
        .map(|part| {
            if part.contains(' ') && !part.starts_with('"') {
                format!("\"{}\"", part)
            } else {
                part.clone()
            }
        })
        .collect::<Vec<String>>()
        .join(" ");

    info!(
        "🖥️ Prepared command for terminal: {}",
        rclone_command_string
    );

    log_operation(
        LogLevel::Info,
        remote_name.clone(),
        Some("Terminal config".to_string()),
        "Opening terminal for rclone config".to_string(),
        Some(json!({ "command": &rclone_command_string })),
    )
    .await;

    // Step 3: Pass the correctly formatted string to the OS-specific functions.
    let result = open_terminal_with_command(rclone_command_string, app.clone()).await;

    match result {
        Ok(_) => {
            let message = "Terminal opened successfully".to_string();
            log_operation(
                LogLevel::Info,
                remote_name,
                Some("Terminal config".to_string()),
                message.clone(),
                None,
            )
            .await;
            info!("✅ {message}");
            Ok(())
        }
        Err(e) => {
            let error_msg = format!("Failed to open terminal: {e}");
            log_operation(
                LogLevel::Error,
                remote_name,
                Some("Terminal config".to_string()),
                "Failed to open terminal".to_string(),
                Some(json!({"error": e.to_string()})),
            )
            .await;
            error!("❌ {error_msg}");
            Err(error_msg)
        }
    }
}

async fn open_terminal_with_command(rclone_command: String, app: AppHandle) -> Result<(), String> {
    let rclone_state = app.state::<RcloneState>();
    let preferred_terminals = rclone_state.terminal_apps.read().unwrap().clone();

    #[cfg(target_os = "windows")]
    return open_windows_terminal(&rclone_command, &preferred_terminals, &app).await;

    #[cfg(target_os = "macos")]
    return open_macos_terminal(&rclone_command, &preferred_terminals, &app).await;

    #[cfg(target_os = "linux")]
    return open_linux_terminal(&rclone_command, &preferred_terminals, &app).await;

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("Unsupported operating system".to_string())
}

#[cfg(target_os = "windows")]
async fn open_windows_terminal(
    rclone_command: &str,
    preferred_terminals: &[String],
    app: &AppHandle,
) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        let full_cmd = terminal_cmd.replace("{}", rclone_command);
        info!("Trying Windows terminal command: {full_cmd}");

        match try_open_windows_terminal(&full_cmd, app).await {
            Ok(_) => {
                info!("✅ Successfully opened Windows terminal with: {terminal_cmd}");
                return Ok(());
            }
            Err(e) => {
                warn!("⚠️ Failed to open Windows terminal with '{terminal_cmd}': {e}");
                last_error = Some(e);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| {
        "No working terminal found. Tried all configured terminals.".to_string()
    }))
}

#[cfg(target_os = "macos")]
async fn open_macos_terminal(
    rclone_command: &str,
    preferred_terminals: &[String],
    app: &AppHandle,
) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        let full_cmd = terminal_cmd.replace("{}", rclone_command);
        info!("Trying macOS terminal command: {full_cmd}");

        match try_open_macos_terminal(&full_cmd, app).await {
            Ok(_) => {
                info!("✅ Successfully opened macOS terminal with: {terminal_cmd}");
                return Ok(());
            }
            Err(e) => {
                warn!("⚠️ Failed to open macOS terminal with '{terminal_cmd}': {e}");
                last_error = Some(e);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "No suitable terminal found on macOS".to_string()))
}

#[cfg(target_os = "linux")]
async fn open_linux_terminal(
    rclone_command: &str,
    preferred_terminals: &[String],
    app: &AppHandle,
) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        let full_cmd = terminal_cmd.replace("{}", rclone_command);

        info!("Trying Linux terminal command: {full_cmd}");

        match try_open_linux_terminal(&full_cmd, app).await {
            Ok(_) => {
                info!("✅ Successfully opened Linux terminal with: {terminal_cmd}");
                return Ok(());
            }
            Err(e) => {
                warn!("⚠️ Failed to open Linux terminal with '{terminal_cmd}': {e}");
                last_error = Some(e);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "No suitable terminal found on Linux".to_string()))
}

// --- NO CHANGES NEEDED BELOW THIS LINE ---

#[cfg(target_os = "windows")]
async fn try_open_windows_terminal(full_command: &str, app: &AppHandle) -> Result<(), String> {
    let (program, args) = parse_command(full_command)?;
    app.shell()
        .command(program)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to spawn terminal: {e}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
async fn try_open_macos_terminal(full_command: &str, app: &AppHandle) -> Result<(), String> {
    let (program, args) = parse_command(full_command)?;
    app.shell()
        .command(program)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to spawn terminal: {e}"))?;
    Ok(())
}

#[cfg(target_os = "linux")]
async fn try_open_linux_terminal(full_command: &str, app: &AppHandle) -> Result<(), String> {
    let (program, args) = parse_command(full_command)?;
    app.shell()
        .command(program)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to spawn terminal: {e}"))?;
    Ok(())
}

fn parse_args(args_str: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current_arg = String::new();
    let mut in_quotes = false;
    let mut quote_char = ' ';
    let mut escape_next = false;
    let mut chars = args_str.chars().peekable();

    while let Some(ch) = chars.next() {
        if escape_next {
            current_arg.push(ch);
            escape_next = false;
            continue;
        }
        match ch {
            '\\' => {
                if in_quotes && chars.peek() == Some(&quote_char) {
                    escape_next = true;
                } else {
                    current_arg.push(ch);
                }
            }
            '"' | '\'' if !in_quotes => {
                in_quotes = true;
                quote_char = ch;
            }
            '"' | '\'' if in_quotes && ch == quote_char => {
                in_quotes = false;
            }
            ' ' | '\t' if !in_quotes => {
                if !current_arg.is_empty() {
                    args.push(current_arg.clone());
                    current_arg.clear();
                }
                while let Some(&next_ch) = chars.peek() {
                    if next_ch == ' ' || next_ch == '\t' {
                        chars.next();
                    } else {
                        break;
                    }
                }
            }
            _ => {
                current_arg.push(ch);
            }
        }
    }
    if !current_arg.is_empty() {
        args.push(current_arg);
    }
    args
}

fn parse_command(full_command: &str) -> Result<(&str, Vec<String>), String> {
    let parts: Vec<&str> = full_command.splitn(2, ' ').collect();
    let (program, args_str) = match parts.as_slice() {
        [prog] => (*prog, ""),
        [prog, args] => (*prog, *args),
        _ => return Err("Invalid command format".to_string()),
    };
    let args = if args_str.is_empty() {
        Vec::new()
    } else {
        parse_args(args_str)
    };
    Ok((program, args))
}
