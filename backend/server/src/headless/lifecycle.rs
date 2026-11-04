use rclone_manager_core::context::AppHandle;

fn relaunch_command() -> Result<std::process::Command, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = std::process::Command::new(executable);
    command.args(std::env::args_os().skip(1));
    Ok(command)
}

#[cfg(unix)]
pub(crate) fn restart(_app: &AppHandle) -> Result<(), String> {
    // Replace the process so containers keep their PID and listening sockets
    // close before the new server starts binding its ports.
    use std::os::unix::process::CommandExt;
    Err(relaunch_command()?.exec().to_string())
}

/// Set once a restart is requested; the process relaunches after its HTTP
/// listener has closed, otherwise the new instance cannot bind the same port.
#[cfg(not(unix))]
static RESTART_PENDING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(not(unix))]
pub(crate) fn restart(app: &AppHandle) -> Result<(), String> {
    RESTART_PENDING.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

/// Starts the replacement process when a restart was requested. Call it once the
/// listener has stopped.
#[cfg(not(unix))]
pub(crate) fn spawn_pending_restart() -> Result<(), String> {
    if RESTART_PENDING.swap(false, std::sync::atomic::Ordering::SeqCst) {
        relaunch_command()?
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
