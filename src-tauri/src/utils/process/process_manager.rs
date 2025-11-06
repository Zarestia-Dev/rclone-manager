use log::{error, info, warn};
use std::path::Path;
use sysinfo::{IS_SUPPORTED_SYSTEM, ProcessesToUpdate, System};

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

/// Check if a filename matches rclone executable (exact match only)
fn is_rclone_executable(filename: &str) -> bool {
    let filename_lower = filename.to_ascii_lowercase();
    filename_lower == "rclone" || filename_lower == "rclone.exe"
}

/// Kill all rclone rcd processes (emergency cleanup)
/// WARNING: This kills ALL rclone processes including OAuth. Only use during application shutdown.
pub fn kill_all_rclone_processes(api_port: u16, oauth_port: u16) -> Result<(), String> {
    info!("🧹 Cleaning up rclone processes on managed ports: API={api_port}, OAuth={oauth_port}");

    #[cfg(target_os = "windows")]
    const TARGET_NAMES: &[&str] = &["rclone.exe"];
    #[cfg(not(target_os = "windows"))]
    const TARGET_NAMES: &[&str] = &["rclone"];

    if !IS_SUPPORTED_SYSTEM {
        warn!("⚠️ sysinfo does not support this platform; falling back to port-only cleanup");
        // Fallback: just kill by port
        kill_processes_on_port(api_port)?;
        kill_processes_on_port(oauth_port)?;
        return Ok(());
    }

    // Step 1: Find PIDs listening on our managed ports
    let api_pids = find_pids_on_port(api_port).unwrap_or_default();
    let oauth_pids = find_pids_on_port(oauth_port).unwrap_or_default();

    let mut port_pids: Vec<u32> = api_pids.into_iter().chain(oauth_pids).collect();
    port_pids.sort_unstable();
    port_pids.dedup();

    if port_pids.is_empty() {
        info!("✅ No processes found on managed ports");
        return Ok(());
    }

    info!(
        "🎯 Found {} process(es) using managed ports: {:?}",
        port_pids.len(),
        port_pids
    );

    // Step 2: Verify these are rclone processes before killing
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let mut killed_count = 0;
    let mut already_gone_count = 0;
    let mut failed_count = 0;

    for pid in port_pids {
        // Verify it's an rclone process
        let is_rclone = if let Some(process) = system.process((pid as usize).into()) {
            let process_name = process.name().to_string_lossy();
            let matches_name = TARGET_NAMES
                .iter()
                .any(|expected| process_name.eq_ignore_ascii_case(expected));

            let matches_cmd = process.cmd().iter().any(|arg| {
                let arg = arg.to_string_lossy();
                if let Some(filename) = Path::new(arg.as_ref()).file_name() {
                    let filename = filename.to_string_lossy();
                    is_rclone_executable(&filename)
                } else {
                    false
                }
            });

            if matches_name || matches_cmd {
                info!("✅ Verified PID {pid} is rclone: {}", process_name);
                true
            } else {
                warn!(
                    "⚠️ PID {pid} on managed port is NOT rclone (name: {}), skipping for safety!",
                    process_name
                );
                false
            }
        } else {
            info!("ℹ️ Process {pid} already exited");
            false
        };

        // Step 3: Only kill if verified as rclone
        if is_rclone {
            match kill_process_by_pid(pid) {
                Ok(_) => {
                    killed_count += 1;
                    info!("✅ Killed rclone process {pid}");
                }
                Err(e) => {
                    if e.contains("already exited") {
                        already_gone_count += 1;
                    } else {
                        warn!("⚠️ Failed to kill rclone process {pid}: {e}");
                        failed_count += 1;
                    }
                }
            }
        }
    }

    info!(
        "Cleanup complete: {} killed, {} already gone, {} failed",
        killed_count, already_gone_count, failed_count
    );

    // Give processes time to fully terminate
    std::thread::sleep(std::time::Duration::from_millis(500));

    Ok(())
}

// /// Get the PID of a child process
// // pub fn get_child_pid(child: &tauri_plugin_shell::process::CommandChild) -> Option<u32> {
// //     Some(child.pid())
// // }
