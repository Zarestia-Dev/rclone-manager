use log::{error, info, warn};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{ShellExt, process::Command};

use crate::{
    core::check_binaries::build_rclone_command,
    utils::{
        logging::log::log_operation,
        types::all_types::{LogLevel, RcloneState},
    },
};

#[tauri::command]
pub async fn open_terminal_config(
    app: AppHandle,
    remote_name: Option<String>,
) -> Result<(), String> {
    // Get rclone binary path from state
    let rclone_command = build_rclone_command(&app, None, None, None);

    // Build the terminal config command
    let terminal_cmd = match remote_name.clone() {
        Some(name) => rclone_command.arg("config").arg("edit").arg(name),
        _ => rclone_command.arg("config"),
    };

    info!("🖥️ Opening terminal for rclone config: {:?}", terminal_cmd);

    log_operation(
        LogLevel::Info,
        remote_name.clone(),
        Some("Terminal config".to_string()),
        "Opening terminal for rclone config".to_string(),
        Some(json!({
            "command": format!("{:?}", terminal_cmd)
        })),
    )
    .await;

    let result = open_terminal_with_command(terminal_cmd, app.clone()).await;

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

async fn open_terminal_with_command(terminal_args: Command, app: AppHandle) -> Result<(), String> {
    let preferred_terminals = app
        .state::<RcloneState>()
        .terminal_apps
        .read()
        .unwrap()
        .clone();

    #[cfg(target_os = "windows")]
    return open_windows_terminal(terminal_args, &preferred_terminals, &app).await;

    #[cfg(target_os = "macos")]
    return open_macos_terminal(terminal_args, &preferred_terminals, &app).await;

    #[cfg(target_os = "linux")]
    return open_linux_terminal(terminal_args, &preferred_terminals, &app).await;

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err("Unsupported operating system".to_string())
}

#[cfg(target_os = "windows")]
async fn open_windows_terminal(
    terminal_args: Command,
    preferred_terminals: &[String],
    app: &AppHandle,
) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        let full_cmd = terminal_cmd.replace("{}", &format!("{:?}", terminal_args));
        info!("Trying Windows terminal command: {full_cmd}");

        match try_open_windows_terminal(&full_cmd, app).await {
            Ok(_) => {
                info!("✅ Successfully opened Windows terminal with: {terminal_cmd}");
                return Ok(());
            }
            Err(e) => {
                warn!("⚠️ Failed to open Windows terminal with '{terminal_cmd}': {e}");
                last_error = Some(e);
                continue;
            }
        }
    }

    Err(last_error.unwrap_or_else(|| {
        "No working terminal found. Tried all configured terminals.".to_string()
    }))
}

#[cfg(target_os = "macos")]
async fn open_macos_terminal(
    terminal_args: Command,
    preferred_terminals: &[String],
    app: &AppHandle,
) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        let full_cmd = terminal_cmd.replace("{}", &format!("{:?}", terminal_args));
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
    terminal_args: Command,
    preferred_terminals: &[String],
    app: &AppHandle,
) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        let full_cmd = terminal_cmd.replace("{}", &format!("{:?}", terminal_args));

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

#[cfg(target_os = "windows")]
async fn try_open_windows_terminal(full_command: &str, app: &AppHandle) -> Result<(), String> {
    info!("Executing Windows terminal command: {full_command}");

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
    info!("Executing macOS terminal command: {full_command}");
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
    info!("Executing Linux terminal command: {full_command}");

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
                // Windows-specific handling: only treat backslash as escape in quotes
                // and only if the next character is the same quote character
                if in_quotes && chars.peek() == Some(&quote_char) {
                    escape_next = true;
                } else {
                    // Otherwise, treat backslash as a literal character (important for Windows paths)
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
                // Skip multiple whitespace
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

/// Parses a full command string into program and arguments
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
