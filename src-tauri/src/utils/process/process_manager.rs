use log::{error, info, warn};

/// Kill a process by PID using platform-specific methods
/// This is a more robust implementation than the basic shell commands
#[tauri::command]
pub fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    info!("🔪 Attempting to kill process with PID: {pid}");

    #[cfg(target_family = "unix")]
    {
        use nix::libc::{SIGKILL, kill};

        let result = unsafe { kill(pid as i32, SIGKILL) };
        if result == 0 {
            info!("✅ Successfully killed process {pid}");
            Ok(())
        } else {
            let error_msg = format!(
                "Failed to kill process {}: {}",
                pid,
                std::io::Error::last_os_error()
            );
            error!("{error_msg}");
            Err(error_msg)
        }
    }

    #[cfg(target_family = "windows")]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;
        use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess};

        let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
        if handle.is_null() {
            let error_msg = format!("Failed to open process {}", pid);
            error!("{}", error_msg);
            return Err(error_msg);
        }

        let result = unsafe { TerminateProcess(handle, 1) };
        unsafe { CloseHandle(handle) };

        if result == 0 {
            let error_msg = format!("Failed to terminate process {}", pid);
            error!("{}", error_msg);
            return Err(error_msg);
        }

        info!("✅ Successfully killed process {}", pid);
        Ok(())
    }
}

/// Find and kill processes using a specific port
pub fn kill_processes_on_port(port: u16) -> Result<(), String> {
    info!("🧹 Cleaning up processes using port {port}");

    let pids = find_pids_on_port(port)?;

    if pids.is_empty() {
        info!("No processes found using port {port}");
        return Ok(());
    }

    for pid in pids {
        match kill_process_by_pid(pid) {
            Ok(_) => info!("✅ Killed process {pid} on port {port}"),
            Err(e) => warn!("⚠️ Failed to kill process {pid} on port {port}: {e}"),
        }
    }

    // Give some time for processes to die
    std::thread::sleep(std::time::Duration::from_millis(500));
    Ok(())
}

/// Find PIDs of processes using a specific port
fn find_pids_on_port(port: u16) -> Result<Vec<u32>, String> {
    #[cfg(unix)]
    {
        // Use lsof to find processes using the port
        let output = std::process::Command::new("lsof")
            .args(["-ti", &format!(":{port}")])
            .output()
            .map_err(|e| format!("Failed to run lsof: {e}"))?;

        let pids_str = String::from_utf8_lossy(&output.stdout);
        let pids: Vec<u32> = pids_str
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .collect();

        Ok(pids)
    }

    #[cfg(windows)]
    {
        // Use netstat to find processes using the port
        let output = std::process::Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .output()
            .map_err(|e| format!("Failed to run netstat: {}", e))?;

        let netstat_output = String::from_utf8_lossy(&output.stdout);
        let mut pids = Vec::new();

        for line in netstat_output.lines() {
            if line.contains(&format!(":{}", port))
                && line.contains("LISTENING")
                && let Some(pid_str) = line.split_whitespace().last()
                && let Ok(pid) = pid_str.parse::<u32>()
            {
                pids.push(pid);
            }
        }

        Ok(pids)
    }
}

/// Kill all rclone rcd processes (emergency cleanup)
/// WARNING: This kills ALL rclone processes including OAuth. Only use during application shutdown.
pub fn kill_all_rclone_processes() -> Result<(), String> {
    info!("🧹 Emergency cleanup: killing ALL rclone processes (including OAuth)");

    #[cfg(unix)]
    {
        // Kill any rclone rcd processes
        let _ = std::process::Command::new("pkill")
            .args(["-f", "rclone rcd"])
            .output();

        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    #[cfg(windows)]
    {
        // Kill rclone.exe processes on Windows
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "rclone.exe"])
            .output();

        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    Ok(())
}

/// Get the PID of a child process
pub fn get_child_pid(child: &std::process::Child) -> Option<u32> {
    Some(child.id())
}
