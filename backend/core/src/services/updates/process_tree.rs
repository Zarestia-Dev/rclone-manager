//! Own only the process tree created for an update trial.
use tokio::process::{Child, Command};

pub(super) fn configure(command: &mut Command) {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    {
        command
            .env(ASSIGNMENT_ENV, "1")
            .stdin(std::process::Stdio::piped());
    }
}

#[cfg(unix)]
pub(super) struct ProcessTree(Option<u32>);

#[cfg(unix)]
impl ProcessTree {
    pub(super) fn attach(child: &Child) -> std::io::Result<Self> {
        child
            .id()
            .map(|pid| Self(Some(pid)))
            .ok_or_else(|| std::io::Error::other("Child already exited"))
    }
    pub(super) fn disarm(&mut self) -> std::io::Result<()> {
        self.0 = None;
        Ok(())
    }
    pub(super) fn terminate(&self) -> std::io::Result<()> {
        let Some(pid) = self.0 else {
            return Ok(());
        };
        if unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(error)
        }
    }
}

#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        if let Err(error) = self.terminate() {
            log::error!("Update process tree cleanup failed: {error}");
        }
    }
}

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
#[cfg(windows)]
const ASSIGNMENT_ENV: &str = "RCMAN_UPDATE_WAIT_FOR_ASSIGNMENT";

#[cfg(windows)]
pub(super) struct ProcessTree(OwnedHandle);

#[cfg(windows)]
impl ProcessTree {
    pub(super) fn attach(child: &Child) -> std::io::Result<Self> {
        use windows_sys::Win32::System::JobObjects::*;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let child_handle = child
            .raw_handle()
            .ok_or_else(|| std::io::Error::other("Child already exited"))?;
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(handle, child_handle) } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(job)
    }
    pub(super) fn disarm(&mut self) -> std::io::Result<()> {
        use windows_sys::Win32::System::JobObjects::*;
        let limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe {
            SetInformationJobObject(
                self.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    pub(super) fn terminate(&self) -> std::io::Result<()> {
        if unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0.as_raw_handle(), 1)
        } == 0
        {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

/// Called at the executable entry point, before any runtime or child processes exist.
#[cfg(windows)]
pub(super) fn wait_for_assignment() {
    if std::env::var_os(ASSIGNMENT_ENV).is_none() {
        return;
    }
    // Entry points call this before creating threads or initializing the GUI.
    unsafe {
        std::env::remove_var(ASSIGNMENT_ENV);
    }
    use std::io::Read;
    let mut permission = [0];
    if std::io::stdin().read_exact(&mut permission).is_err() || permission != [1] {
        std::process::exit(1);
    }
}

#[cfg(windows)]
pub(super) async fn release_child(child: &mut Child) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("Missing update launch gate"))?;
    input.write_all(&[1]).await
}

#[cfg(windows)]
pub(super) struct Parent(OwnedHandle);

#[cfg(windows)]
impl Parent {
    pub(super) fn open(pid: u32) -> std::io::Result<Self> {
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle) }))
        }
    }
    pub(super) fn wait(&self) -> std::io::Result<()> {
        use windows_sys::Win32::{
            Foundation::WAIT_OBJECT_0,
            System::Threading::{INFINITE, WaitForSingleObject},
        };
        if unsafe { WaitForSingleObject(self.0.as_raw_handle(), INFINITE) } == WAIT_OBJECT_0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn process_fixture() {
        let Ok(mode) = std::env::var("RCMAN_PROCESS_FIXTURE") else {
            return;
        };
        if mode == "parent" {
            std::thread::sleep(std::time::Duration::from_millis(150));
            return;
        }
        wait_for_assignment();
        let marker = std::env::var_os("RCMAN_PROCESS_MARKER").unwrap();
        if mode == "tree" {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "services::updates::process_tree::tests::process_fixture",
                ])
                .env("RCMAN_PROCESS_FIXTURE", "descendant")
                .spawn()
                .unwrap();
            child.wait().unwrap();
        } else {
            for index in 0..1000 {
                std::fs::write(&marker, index.to_string()).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }

    #[test]
    fn parent_handle_waits_for_real_exit() {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "services::updates::process_tree::tests::process_fixture",
            ])
            .env("RCMAN_PROCESS_FIXTURE", "parent")
            .spawn()
            .unwrap();
        let parent = Parent::open(child.id()).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        parent.wait().unwrap();
        assert!(child.try_wait().unwrap().unwrap().success());
    }

    #[tokio::test]
    async fn launch_gate_and_job_cover_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("activity");
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "services::updates::process_tree::tests::process_fixture",
            ])
            .env("RCMAN_PROCESS_FIXTURE", "tree")
            .env("RCMAN_PROCESS_MARKER", &marker)
            .kill_on_drop(true);
        configure(&mut command);
        let mut child = command.spawn().unwrap();
        let tree = ProcessTree::attach(&child).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(!marker.exists());
        release_child(&mut child).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !marker.exists() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        tree.terminate().unwrap();
        child.wait().await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let content = std::fs::read(&marker).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(std::fs::read(marker).unwrap(), content);
    }
}
