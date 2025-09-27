use log::{error, info, warn};
use serde_json::json;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Manager};
use tokio::process::Command as TokioCommand;

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

    // // Escape the path
    // let escaped_rclone_path = escape_path(&rclone_path.to_string_lossy());
    // debug!("Using rclone path: {escaped_rclone_path}");

    let config_command = match remote_name.clone() {
        Some(name) => {
            let mut cmd = rclone_command;
            cmd.arg("config").arg("edit").arg(name);
            cmd
        }
        _ => {
            let mut cmd = rclone_command;
            cmd.arg("config");
            cmd
        }
    };

    info!(
        "🖥️ Opening terminal for rclone config: {:?}",
        config_command
    );

    log_operation(
        LogLevel::Info,
        remote_name.clone(),
        Some("Terminal config".to_string()),
        "Opening terminal for rclone config".to_string(),
        Some(json!({
            "command": format!("{:?}", config_command)
        })),
    )
    .await;

    let result = open_terminal_with_command(config_command, app.clone()).await;

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

async fn open_terminal_with_command(command: Command, app: AppHandle) -> Result<(), String> {
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
    Err("Unsupported operating system".to_string())
}

#[cfg(target_os = "windows")]
async fn open_windows_terminal(
    command: Command,
    preferred_terminals: &[String],
) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        // Escape the command properly for Windows
        // let escaped_command = if command.contains(' ') {
        //     format!("\"{}\"", command.replace('\"', "\"\""))
        // } else {
        //     command.to_string()
        // };

        // Convert Command to a string representation
        let command_str = format!("{:?}", command);
        let full_cmd = terminal_cmd.replace("{}", &command_str);
        info!("Trying Windows terminal command: {full_cmd}");

        match try_open_windows_terminal(&full_cmd).await {
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
    command: Command,
    preferred_terminals: &[String],
) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        // Convert Command to a string representation
        let command_str = format!("{:?}", command);
        let full_cmd = terminal_cmd.replace("{}", &command_str);
        info!("Trying macOS terminal command: {full_cmd}");

        match try_open_macos_terminal(&full_cmd).await {
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
    command: Command,
    preferred_terminals: &[String],
) -> Result<(), String> {
    let mut last_error = None;

    for terminal_cmd in preferred_terminals {
        // Convert Command to a string representation
        let command_str = format!("{:?}", command);
        let full_cmd = terminal_cmd.replace("{}", &command_str);

        info!("Trying Linux terminal command: {full_cmd}");

        match try_open_linux_terminal(&full_cmd).await {
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
async fn try_open_windows_terminal(full_command: &str) -> Result<(), String> {
    info!("Executing Windows terminal command: {full_command}");

    let (program, args) = parse_command(full_command)?;
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
    let (program, args) = parse_command(full_command)?;

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

    let (program, args) = parse_command(full_command)?;

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

// fn escape_path(path: &str) -> String {
//     if path.contains(' ') {
//         format!("'{}'", path.replace('"', "\\\""))
//     } else {
//         path.to_string()
//     }
// }

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
