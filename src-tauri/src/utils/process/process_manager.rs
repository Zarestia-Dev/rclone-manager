use log::{error, info, warn};

/// Kill a process by PID using platform-specific methods
/// This is a more robust implementation than the basic shell commands
#[tauri::command]
pub fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    info!("🔪 Attempting to kill process with PID: {pid}");

    #[cfg(target_family = "unix")]
    {
        use nix::libc::{EPERM, ESRCH, SIGKILL, kill};

        let result = unsafe { kill(pid as i32, SIGKILL) };
        if result == 0 {
            info!("✅ Successfully killed process {pid}");
            Ok(())
        } else {
            let err = std::io::Error::last_os_error();
            let errno = err.raw_os_error();

            match errno {
                Some(ESRCH) => {
                    // ESRCH (errno 3) means "No such process" - it's already gone
                    info!("✅ Process {pid} already exited");
                    Ok(())
                }
                Some(EPERM) => {
                    // EPERM (errno 1) means "Operation not permitted"
                    let error_msg = format!("Permission denied to kill process {pid}");
                    error!("{error_msg}");
                    Err(error_msg)
                }
                _ => {
                    let error_msg = format!("Failed to kill process {pid}: {err}");
                    error!("{error_msg}");
                    Err(error_msg)
                }
            }
        }
    }

    #[cfg(target_family = "windows")]
    {
        use windows_sys::Win32::Foundation::{
            CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_TERMINATE, TerminateProcess,
        };

        let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
        if handle.is_null() {
            let err = std::io::Error::last_os_error();
            let err_code = err.raw_os_error();

            // ERROR_INVALID_PARAMETER (87) means process doesn't exist
            if err_code == Some(ERROR_INVALID_PARAMETER as i32) {
                info!("✅ Process {pid} already exited");
                return Ok(());
            }
            // ERROR_ACCESS_DENIED (5) means we don't have permission
            if err_code == Some(ERROR_ACCESS_DENIED as i32) {
                let error_msg = format!("Permission denied to open process {pid}");
                error!("{error_msg}");
                return Err(error_msg);
            }

            let error_msg = format!("Failed to open process {pid}: {err}");
            error!("{error_msg}");
            return Err(error_msg);
        }

        let result = unsafe { TerminateProcess(handle, 1) };
        unsafe { CloseHandle(handle) };

        if result == 0 {
            let err = std::io::Error::last_os_error();
            let error_msg = format!("Failed to terminate process {pid}: {err}");
            error!("{error_msg}");
            return Err(error_msg);
        }

        info!("✅ Successfully killed process {pid}");
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

    let mut success_count = 0;
    let mut fail_count = 0;

    for pid in pids {
        match kill_process_by_pid(pid) {
            Ok(_) => {
                info!("✅ Killed process {pid} on port {port}");
                success_count += 1;
            }
            Err(e) => {
                warn!("⚠️ Failed to kill process {pid} on port {port}: {e}");
                fail_count += 1;
            }
        }
    }

    info!("Port {port} cleanup: {success_count} killed, {fail_count} failed");

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
            pids.extend(socket_info.associated_pids.iter().copied());
        }
    }

    pids.sort_unstable();
    pids.dedup();

    Ok(pids)
}

/// Kill all rclone processes on managed ports (emergency cleanup during shutdown)
/// This is safe because we only target our specific API and OAuth ports.
pub fn kill_all_rclone_processes(api_port: u16, oauth_port: u16) -> Result<(), String> {
    info!("🧹 Cleaning up rclone processes on managed ports: API={api_port}, OAuth={oauth_port}");

    // Kill by port is already precise - we only kill processes WE started on our ports
    if let Err(e) = kill_processes_on_port(api_port) {
        warn!("⚠️ Failed to cleanup API port {api_port}: {e}");
    }

    if let Err(e) = kill_processes_on_port(oauth_port) {
        warn!("⚠️ Failed to cleanup OAuth port {oauth_port}: {e}");
    }

    info!("✅ Port cleanup complete");
    Ok(())
}

/// Aggressively clean up WebKitGTK zombie processes on Linux
/// This finds any "WebKitNetworkProcess" that belongs to THIS application
/// and kills it.
#[cfg(all(target_os = "linux", not(feature = "web-server")))]
pub fn cleanup_webkit_zombies() {
    use log::{debug, info};
    use sysinfo::{ProcessesToUpdate, System};

    // Refresh process list
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let my_pid = std::process::id();
    let mut killed_count = 0;

    for (pid, process) in system.processes() {
        let name = process.name().to_string_lossy();

        // Target WebKit processes
        if name.contains("WebKitNetwork") || name.contains("WebKitWeb") {
            // CRITICAL: Only kill if it is a CHILD of our main app
            if let Some(parent_pid) = process.parent()
                && parent_pid.as_u32() == my_pid
            {
                debug!("🧟 Found zombie WebKit process: {} (PID: {})", name, pid);
                if process.kill() {
                    killed_count += 1;
                }
            }
        }
    }

    if killed_count > 0 {
        info!("✅ Cleaned up {} WebKit zombie processes", killed_count);
    } else {
        debug!("🧹 No WebKit zombies found.");
    }
}
