use rclone_manager_core::context::AppHandle;

pub(crate) fn restart(_app: &AppHandle) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = std::process::Command::new(executable);
    command.args(std::env::args_os().skip(1));
    #[cfg(unix)]
    {
        // Replace the process so containers keep their PID and listening sockets
        // close before the new server starts binding its ports.
        use std::os::unix::process::CommandExt;
        Err(command.exec().to_string())
    }
    #[cfg(not(unix))]
    {
        command.spawn().map_err(|error| error.to_string())?;
        _app.exit(0);
        Ok(())
    }
}
