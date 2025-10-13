use log::{error, info, warn};
use sysinfo::{IS_SUPPORTED_SYSTEM, ProcessesToUpdate, System};

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

/// Find PIDs of processes using a specific port without spawning shell tools
fn find_pids_on_port(port: u16) -> Result<Vec<u32>, String> {
    use netstat2::{
        AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState, get_sockets_info,
    };

    let families = AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6;
    let protocols = ProtocolFlags::TCP;

    let mut pids = Vec::new();
    let sockets = get_sockets_info(families, protocols)
        .map_err(|e| format!("Failed to enumerate sockets: {e}"))?;

    for socket_info in sockets {
        if let ProtocolSocketInfo::Tcp(tcp_info) = &socket_info.protocol_socket_info
            && tcp_info.local_port == port
            && matches!(tcp_info.state, TcpState::Listen)
        {
            // Duplicate PIDs are deduped later; collect everything for now.
            pids.extend(socket_info.associated_pids.iter().copied());
        }
    }

    pids.sort_unstable();
    pids.dedup();

    Ok(pids)
}

/// Kill all rclone rcd processes (emergency cleanup)
/// WARNING: This kills ALL rclone processes including OAuth. Only use during application shutdown.
pub fn kill_all_rclone_processes() -> Result<(), String> {
    info!("🧹 Emergency cleanup: killing ALL rclone processes (including OAuth)");

    #[cfg(target_os = "windows")]
    const TARGET_NAMES: &[&str] = &["rclone.exe"];
    #[cfg(not(target_os = "windows"))]
    const TARGET_NAMES: &[&str] = &["rclone"];

    if !IS_SUPPORTED_SYSTEM {
        warn!("⚠️ sysinfo does not support this platform; falling back to no-op cleanup");
        return Ok(());
    }

    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let mut target_pids: Vec<u32> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let process_name = process.name().to_string_lossy();
            let matches_name = TARGET_NAMES
                .iter()
                .any(|expected| process_name.eq_ignore_ascii_case(expected));

            let matches_cmd = process.cmd().iter().any(|arg| {
                let arg = arg.to_string_lossy();
                arg.to_ascii_lowercase().contains("rclone")
            });

            if matches_name || matches_cmd {
                Some(pid.as_u32())
            } else {
                None
            }
        })
        .collect();

    target_pids.sort_unstable();
    target_pids.dedup();

    if target_pids.is_empty() {
        info!("No rclone processes found to kill");
        return Ok(());
    }

    for pid in target_pids {
        match kill_process_by_pid(pid) {
            Ok(_) => info!("✅ Killed rclone process {pid}"),
            Err(e) => warn!("⚠️ Failed to kill rclone process {pid}: {e}"),
        }
    }

    std::thread::sleep(std::time::Duration::from_millis(500));

    Ok(())
}

/// Get the PID of a child process
pub fn get_child_pid(child: &std::process::Child) -> Option<u32> {
    Some(child.id())
}
