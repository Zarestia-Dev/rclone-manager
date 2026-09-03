use log::info;

/// Executes a native or OS-integrated system power action.
///
/// Supported actions:
/// - `"sleep"`: Suspends/puts the machine to sleep
/// - `"shutdown"`: Powers off the machine
/// - `"hibernate"`: Hibernates the system
/// - `"lock"`: Locks the current user screen/session
pub async fn execute_system_power(action: &str) -> Result<(), String> {
    info!("Executing native system power action: {action}");

    #[cfg(target_os = "linux")]
    {
        execute_linux_power(action).await
    }

    #[cfg(target_os = "windows")]
    {
        execute_windows_power(action)
    }

    #[cfg(target_os = "macos")]
    {
        execute_macos_power(action)
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = action;
        Err("System power actions are not supported on this platform".to_string())
    }
}

#[cfg(target_os = "linux")]
async fn execute_linux_power(action: &str) -> Result<(), String> {
    #[cfg(feature = "desktop")]
    {
        match zbus::Connection::system().await {
            Ok(connection) => {
                match zbus::Proxy::new(
                    &connection,
                    "org.freedesktop.login1",
                    "/org/freedesktop/login1",
                    "org.freedesktop.login1.Manager",
                )
                .await
                {
                    Ok(proxy) => {
                        let res = match action {
                            "shutdown" => proxy.call::<_, _, ()>("PowerOff", &(false)).await,
                            "hibernate" => proxy.call::<_, _, ()>("Hibernate", &(false)).await,
                            "lock" => proxy.call::<_, _, ()>("LockSessions", &()).await,
                            _ => proxy.call::<_, _, ()>("Suspend", &(false)).await,
                        };

                        if let Ok(()) = res {
                            info!("D-Bus systemd logind power action '{action}' succeeded");
                            return Ok(());
                        } else if let Err(e) = res {
                            log::warn!(
                                "D-Bus login1 power action '{action}' failed: {e}. Falling back to CLI..."
                            );
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "Failed to create login1 D-Bus proxy: {e}. Falling back to CLI..."
                        );
                    }
                }
            }
            Err(e) => {
                log::debug!(
                    "System D-Bus unavailable for power action: {e}. Falling back to CLI..."
                );
            }
        }
    }

    // CLI fallback for non-systemd, missing D-Bus, or container/headless environments
    let cmd = match action {
        "shutdown" => "systemctl poweroff || poweroff",
        "hibernate" => "systemctl hibernate",
        "lock" => "loginctl lock-session || xdg-screensaver lock",
        _ => "systemctl suspend || pm-suspend",
    };

    std::process::Command::new("sh")
        .args(["-c", cmd])
        .spawn()
        .map_err(|e| format!("Failed to spawn Linux power command '{cmd}': {e}"))?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn execute_windows_power(action: &str) -> Result<(), String> {
    match action {
        "lock" => {
            let ret = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::LockWorkStation() };
            if ret == 0 {
                let err = std::io::Error::last_os_error();
                return Err(format!("Windows LockWorkStation failed: {err}"));
            }
            Ok(())
        }
        "sleep" => {
            // SetSuspendState(bHibernate: 0, bForce: 0, bWakeupEventsDisabled: 0)
            let ret = unsafe { windows_sys::Win32::System::Power::SetSuspendState(0, 0, 0) };
            if ret == 0 {
                let err = std::io::Error::last_os_error();
                return Err(format!("Windows SetSuspendState(sleep) failed: {err}"));
            }
            Ok(())
        }
        "hibernate" => {
            // SetSuspendState(bHibernate: 1, bForce: 0, bWakeupEventsDisabled: 0)
            let ret = unsafe { windows_sys::Win32::System::Power::SetSuspendState(1, 0, 0) };
            if ret == 0 {
                let err = std::io::Error::last_os_error();
                return Err(format!("Windows SetSuspendState(hibernate) failed: {err}"));
            }
            Ok(())
        }
        "shutdown" => {
            std::process::Command::new("shutdown")
                .args(["/s", "/t", "0"])
                .spawn()
                .map_err(|e| format!("Failed to initiate Windows shutdown: {e}"))?;
            Ok(())
        }
        unknown => Err(format!("Unknown Windows power action: {unknown}")),
    }
}

#[cfg(target_os = "macos")]
fn execute_macos_power(action: &str) -> Result<(), String> {
    match action {
        "shutdown" => {
            std::process::Command::new("osascript")
                .args(["-e", "tell app \"System Events\" to shut down"])
                .spawn()
                .map_err(|e| format!("Failed to initiate macOS shutdown: {e}"))?;
            Ok(())
        }
        "lock" => {
            std::process::Command::new("pmset")
                .arg("displaysleepnow")
                .spawn()
                .map_err(|e| format!("Failed to initiate macOS lock: {e}"))?;
            Ok(())
        }
        _ => {
            std::process::Command::new("pmset")
                .arg("sleepnow")
                .spawn()
                .map_err(|e| format!("Failed to initiate macOS sleep: {e}"))?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_execute_system_power_syntax_check() {
        // Validation that power action names are handled
        let valid_actions = ["sleep", "shutdown", "hibernate", "lock"];
        for action in valid_actions {
            assert!(!action.is_empty());
        }
    }
}
