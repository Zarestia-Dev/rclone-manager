//! One server owns a data directory and its engine. A Send To started while it
//! runs (from the Windows Send To menu or a file manager) leaves its transfer in
//! the inbox and exits; any other second start exits at once.
use rclone_manager_core::context::AppHandle;
use rclone_manager_core::services::{cli::GeneralArgs, paths::AppPaths};
use std::path::{Path, PathBuf};

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Request {
    remote: String,
    path: Option<String>,
    sources: Vec<PathBuf>,
    cwd: PathBuf,
}

/// Held for the life of the server that owns the data directory.
struct Owner {
    /// Held until the process exits, or until [`release`] on Windows.
    _lock: std::sync::Mutex<Option<std::fs::File>>,
    inbox: PathBuf,
}

/// Takes the data directory or, for a Send To, hands the transfer to the server
/// that has it and exits. A second plain start exits before it touches the data
/// directory or starts an engine. Runs before the engine is set up.
pub(super) fn claim(app: &AppHandle, paths: &AppPaths) -> Result<(), String> {
    let inbox = paths.config_dir.join("send-to");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(paths.config_dir.join("instance.lock"))
        .map_err(|error| error.to_string())?;
    match lock.try_lock() {
        Ok(()) => {
            app.manage(Owner {
                _lock: std::sync::Mutex::new(Some(lock)),
                inbox,
            });
            Ok(())
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            let args = app.state::<GeneralArgs>();
            let Some(remote) = args.send_to_remote.clone() else {
                let message = format!(
                    "{} is already running with {}",
                    crate::PRODUCT.display_name,
                    paths.config_dir.display()
                );
                log::info!("{message}");
                eprintln!("{message}");
                std::process::exit(0);
            };
            let request = Request {
                remote,
                path: args.send_to_path.clone(),
                sources: args.send_to_sources.clone(),
                cwd: std::env::current_dir().map_err(|error| error.to_string())?,
            };
            hand_over(&inbox, &request).map_err(|error| error.to_string())?;
            std::process::exit(0);
        }
        Err(std::fs::TryLockError::Error(error)) => Err(error.to_string()),
    }
}

/// Written under a temporary name and renamed, so the owner never reads half a file.
fn hand_over(inbox: &Path, request: &Request) -> std::io::Result<()> {
    create_inbox(inbox)?;
    let mut file = tempfile::Builder::new()
        .prefix("send-to-")
        .tempfile_in(inbox)?;
    serde_json::to_writer(&mut file, request)?;
    let request = file.path().with_extension("json");
    file.persist(request)?;
    Ok(())
}

/// A request in the inbox uploads the files it names, so only this user may write
/// there, also when the data directory is shared.
fn create_inbox(inbox: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(inbox)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(inbox, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Gives up the data directory before this process starts its replacement, which
/// would otherwise find it taken and exit. (On Unix the replacement is an `exec`,
/// which closes the lock.)
#[cfg(not(unix))]
pub(super) fn release(app: &AppHandle) {
    if let Some(owner) = app.try_state::<Owner>() {
        owner
            ._lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
}

/// Runs the transfers other launches hand over. Call once the application is set up.
pub(super) fn serve(app: &AppHandle) {
    let Some(owner) = app.try_state::<Owner>() else {
        return;
    };
    match watch(app, &owner.inbox) {
        Ok(watcher) => {
            app.manage(watcher);
        }
        Err(error) => log::error!("SendTo from other launches is unavailable: {error}"),
    }
}

fn watch(app: &AppHandle, inbox: &Path) -> Result<notify::RecommendedWatcher, String> {
    use notify::Watcher;
    create_inbox(inbox).map_err(|error| error.to_string())?;
    let owner = app.clone();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        for path in event.map(|event| event.paths).unwrap_or_default() {
            run(&owner, &path);
        }
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(inbox, notify::RecursiveMode::NonRecursive)
        .map_err(|error| error.to_string())?;
    // Requests left by a server that stopped before running them.
    for entry in std::fs::read_dir(inbox)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        run(app, &entry.path());
    }
    Ok(watcher)
}

/// Each request runs once: the file is taken before the transfer starts.
fn run(app: &AppHandle, path: &Path) {
    let Some(request) = take(path) else {
        return;
    };
    let app = app.clone();
    rclone_manager_core::utils::spawn(async move {
        let result = rclone_manager_core::app::send_to::execute_when_ready(
            &app,
            request.remote,
            request.path,
            request.sources,
            Some(&request.cwd),
        )
        .await;
        match result {
            Ok(jobid) => log::info!("SendTo transfer from another launch started: {jobid}"),
            Err(error) => log::error!("SendTo transfer from another launch failed: {error}"),
        }
    });
}

/// The startup scan and the watcher can both see a request; renaming it is atomic,
/// so only one of them gets it.
fn take(path: &Path) -> Option<Request> {
    if path.extension().is_none_or(|extension| extension != "json") {
        return None;
    }
    let taken = path.with_extension("taken");
    std::fs::rename(path, &taken).ok()?;
    let bytes = std::fs::read(&taken);
    let _ = std::fs::remove_file(&taken);
    let bytes = bytes.ok()?;
    serde_json::from_slice(&bytes)
        .inspect_err(|error| log::warn!("Ignoring invalid SendTo request: {error}"))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_handed_over_request_is_read_once() {
        let inbox = tempfile::tempdir().unwrap();
        let request = Request {
            remote: "NAS & 旅行:".into(),
            path: Some("Photos/özel".into()),
            sources: vec!["a file.txt".into(), "/abs/b".into()],
            cwd: "/home/user/Desktop".into(),
        };
        hand_over(inbox.path(), &request).unwrap();
        let files: Vec<_> = std::fs::read_dir(inbox.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].extension().unwrap(), "json");
        assert_eq!(take(&files[0]), Some(request));
        assert_eq!(take(&files[0]), None);
    }

    #[test]
    fn only_one_of_two_readers_gets_a_request() {
        let inbox = tempfile::tempdir().unwrap();
        let request = Request {
            remote: "r:".into(),
            path: None,
            sources: vec!["a".into()],
            cwd: "/".into(),
        };
        hand_over(inbox.path(), &request).unwrap();
        let file = std::fs::read_dir(inbox.path())
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let readers: Vec<_> = (0..2)
            .map(|_| {
                let file = file.clone();
                std::thread::spawn(move || take(&file))
            })
            .collect();
        let taken: Vec<_> = readers
            .into_iter()
            .filter_map(|reader| reader.join().unwrap())
            .collect();
        assert_eq!(taken, [request]);
        assert_eq!(std::fs::read_dir(inbox.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn only_this_user_can_leave_requests() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let inbox = data.path().join("send-to");
        std::fs::create_dir(&inbox).unwrap();
        std::fs::set_permissions(&inbox, std::fs::Permissions::from_mode(0o777)).unwrap();
        create_inbox(&inbox).unwrap();
        let mode = std::fs::metadata(&inbox).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn unfinished_and_invalid_files_are_not_requests() {
        let inbox = tempfile::tempdir().unwrap();
        let partial = inbox.path().join(".tmpabc");
        std::fs::write(&partial, b"{").unwrap();
        assert_eq!(take(&partial), None);
        assert!(partial.exists());
        let invalid = inbox.path().join("bad.json");
        std::fs::write(&invalid, b"not json").unwrap();
        assert_eq!(take(&invalid), None);
        assert!(!invalid.exists());
    }

    #[test]
    fn a_second_lock_on_the_same_directory_waits_for_the_first() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("instance.lock");
        let first = std::fs::File::create(&path).unwrap();
        first.try_lock().unwrap();
        let second = std::fs::File::create(&path).unwrap();
        assert!(matches!(
            second.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(first);
        second.try_lock().unwrap();
    }
}
