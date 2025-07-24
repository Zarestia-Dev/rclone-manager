use log::{error, info};
use serde_json::json;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager, State};
use tokio::process::Command as TokioCommand;

use crate::{
    core::check_binaries::read_rclone_path,
    utils::{
        logging::log::log_operation,
        types::all_types::{LogLevel, RcloneState},
    },
};

#[tauri::command]
pub async fn open_terminal_config(
    app: AppHandle,
    remote_name: Option<String>,
    _state: State<'_, RcloneState>,
) -> Result<(), String> {
    // Get rclone binary path from state
    let rclone_path = read_rclone_path(&app);
    let config_command = match remote_name.clone() {
        Some(name) => format!("{} config update {}", rclone_path.display(), name),
        _ => format!("{} config", rclone_path.display()),
    };

    info!("🖥️ Opening terminal for rclone config: {config_command}");

    log_operation(
        LogLevel::Info,
        remote_name.clone(),
        Some("Terminal config".to_string()),
        "Opening terminal for rclone config".to_string(),
        Some(json!({
            "command": config_command
        })),
    )
    .await;

    let result = open_terminal_with_command(&config_command, app.clone()).await;

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

async fn open_terminal_with_command(command: &str, app: AppHandle) -> Result<(), String> {
    let preferred_terminals = app
        .state::<RcloneState>()
        .terminal_apps
        .read()
        .unwrap()
        .clone();

    #[cfg(target_os = "windows")]
    return open_windows_terminal(command, &preferred_terminals).await;

    #[cfg(target_os = "macos")]
    return open_macos_terminal(command, &preferred_terminals).await;

    #[cfg(target_os = "linux")]
    return open_linux_terminal(command, &preferred_terminals).await;

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err("Unsupported operating system".to_string());
}

#[cfg(target_os = "windows")]
async fn open_windows_terminal(
    command: &str,
    preferred_terminals: &[String],
) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        // Escape the command properly for Windows
        let escaped_command = if command.contains(' ') {
            format!("\"{}\"", command.replace('\"', "\"\""))
        } else {
            command.to_string()
        };

        let full_cmd = terminal_cmd.replace("{}", &escaped_command);
        info!("Trying Windows terminal command: {}", full_cmd);

        match try_open_windows_terminal(&full_cmd).await {
            Ok(_) => return Ok(()),
            Err(e) => {
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
async fn open_macos_terminal(command: &str, preferred_terminals: &[String]) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        let full_cmd = terminal_cmd.replace("{}", command);
        info!("Trying macOS terminal command: {}", full_cmd);

        match try_open_macos_terminal(&full_cmd).await {
            Ok(_) => {
                info!("Successfully opened macOS terminal");
                return Ok(());
            }
            Err(e) => {
                info!("Failed to open terminal with command '{}': {}", full_cmd, e);
                last_error = Some(e);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "No suitable terminal found on macOS".to_string()))
}

#[cfg(target_os = "linux")]
async fn open_linux_terminal(command: &str, preferred_terminals: &[String]) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        let full_cmd = terminal_cmd.replace("{}", command);

        // Extract the terminal binary name to check if it exists
        let terminal_binary = full_cmd.split_whitespace().next().unwrap_or("");

        info!("Trying Linux terminal command: {full_cmd}");

        match try_open_linux_terminal(&full_cmd).await {
            Ok(_) => {
                info!("Successfully opened Linux terminal");
                return Ok(());
            }
            Err(e) => {
                info!("Failed to open terminal with command '{full_cmd}': {e}");
                last_error = Some(e);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "No suitable terminal found on Linux".to_string()))
}

#[cfg(target_os = "windows")]
async fn try_open_windows_terminal(full_command: &str) -> Result<(), String> {
    info!("Executing Windows terminal command: {full_command}");

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

    match TokioCommand::new(program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to spawn terminal: {e}")),
    }
}

#[cfg(target_os = "macos")]
async fn try_open_macos_terminal(full_command: &str) -> Result<(), String> {
    info!("Executing macOS terminal command: {full_command}");

    // For osascript commands
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

    match TokioCommand::new(program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(_) => {
            // For macOS terminals, we assume success if we can spawn
            Ok(())
        }
        Err(e) => Err(format!("Failed to spawn terminal: {e}")),
    }
}

#[cfg(target_os = "linux")]
async fn try_open_linux_terminal(full_command: &str) -> Result<(), String> {
    info!("Executing Linux terminal command: {full_command}");

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

    match TokioCommand::new(program)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(_) => {
            // For Linux terminals, we assume success if we can spawn
            Ok(())
        }
        Err(e) => Err(format!("Failed to spawn terminal: {e}")),
    }
}

// Improved argument parser
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
            '\\' if in_quotes => {
                escape_next = true;
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
