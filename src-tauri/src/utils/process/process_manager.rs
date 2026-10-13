use log::{info, warn};

use crate::core::bridge;

#[cfg(unix)]
use nix::libc::{EPERM, ESRCH, SIGKILL, kill};
#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER},
    System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, TerminateProcess,
    },
};

/// Kill a process by PID using platform-specific methods
#[bridge]
pub fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    info!("Killing process {pid}");

    #[cfg(unix)]
    unsafe {
        if kill(pid as i32, SIGKILL) == 0 {
            return Ok(());
        }

        let err = std::io::Error::last_os_error();
        match err.raw_os_error() {
            Some(ESRCH) => Ok(()), // Already dead
            _ => Err(format!("Failed to kill process {pid}: {err}")),
        }
    }

    #[cfg(windows)]
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            let err = std::io::Error::last_os_error();
            // If process doesn't exist (INVALID_PARAMETER) or we can't access it (ACCESS_DENIED),
            // check if it's already gone or unreachable.
            if err.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                return Ok(());
            }
            return Err(format!("Failed to open process {pid}: {err}"));
        }

        let result = TerminateProcess(handle, 1);
        CloseHandle(handle);

        if result == 0 {
            Err(format!(
                "Failed to terminate process {pid}: {}",
                std::io::Error::last_os_error()
            ))
        } else {
            Ok(())
        }
    }
}

/// Check if a process with the given PID is still running
#[must_use]
pub fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        // signal 0 checks existence
        if kill(pid as i32, 0) == 0 {
            return true;
        }
        let errno = std::io::Error::last_os_error().raw_os_error();
        // EPERM means it exists but we can't signal it (owned by another user/root)
        errno == Some(EPERM)
    }

    #[cfg(windows)]
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            let errno = std::io::Error::last_os_error().raw_os_error();
            // ACCESS_DENIED means it exists but we can't open it
            errno == Some(ERROR_ACCESS_DENIED as i32)
        } else {
            CloseHandle(handle);
            true
        }
    }
}

/// Find and kill processes using a specific port
pub fn kill_processes_on_port(port: u16) -> Result<(), String> {
    let pids = find_pids_on_port(port)?;
    if pids.is_empty() {
        return Ok(());
    }

    info!("Cleaning up port {port} (PIDs: {pids:?})");

    for pid in pids {
        if let Err(e) = kill_process_by_pid(pid) {
            warn!("Failed to kill {pid}: {e}");
        }
    }

    // Brief pause to allow OS cleanup
    std::thread::sleep(std::time::Duration::from_millis(100));
    Ok(())
}

/// Find PIDs of processes using a specific port
fn find_pids_on_port(port: u16) -> Result<Vec<u32>, String> {
    use netstat2::{
        AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState, get_sockets_info,
    };

    let flags = AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6;
    let sockets = get_sockets_info(flags, ProtocolFlags::TCP)
        .map_err(|e| format!("Failed to enumerate sockets: {e}"))?;

    let mut pids = sockets
        .into_iter()
        .filter_map(|s| match s.protocol_socket_info {
            ProtocolSocketInfo::Tcp(tcp)
                if tcp.local_port == port && tcp.state == TcpState::Listen =>
            {
                Some(s.associated_pids)
            }
            _ => None,
        })
        .flatten()
        .collect::<Vec<_>>();

    pids.sort_unstable();
    pids.dedup();
    Ok(pids)
}

/// Kill all rclone processes on the managed API port.
pub fn kill_all_rclone_processes(api_port: u16) -> Result<(), String> {
    let _ = kill_processes_on_port(api_port);
    Ok(())
}

/// Check if a local TCP port is already bound / occupied.
#[must_use]
pub fn is_port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

/// Find the next available TCP port starting from `start_port`.
#[must_use]
pub fn find_next_available_port(start_port: u16) -> u16 {
    for port in start_port..=65535 {
        if !is_port_in_use(port) {
            return port;
        }
    }
    for port in 1024..start_port {
        if !is_port_in_use(port) {
            return port;
        }
    }
    start_port
}
