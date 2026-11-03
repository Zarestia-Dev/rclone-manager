use crate::rclone::commands::upload::UploadBatchParams;

pub fn build_send_to_params(
    remote: String,
    path: Option<String>,
    sources: Vec<std::path::PathBuf>,
    cwd: Option<&std::path::Path>,
) -> UploadBatchParams {
    let local_paths = sources
        .into_iter()
        .map(|p| match cwd {
            Some(base) if p.is_relative() => base.join(p),
            _ => p,
        })
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    UploadBatchParams {
        backend: None,
        remote,
        path: path.unwrap_or_default(),
        local_paths,
        origin: Some(crate::utils::types::origin::Origin::FileManager),
        group: Some("send_to".to_string()),
        existing_jobid: None,
        no_cache: false,
        empty_dirs: Vec::new(),
    }
}
/// Runs a "Send to" transfer: builds the upload from the command line and starts it.
///
/// Launching the program from a file manager must not bypass the vault lock, so a
/// locked session refuses.
pub async fn execute(
    app: &crate::context::AppHandle,
    remote: String,
    path: Option<String>,
    sources: Vec<std::path::PathBuf>,
    cwd: Option<&std::path::Path>,
) -> Result<String, String> {
    if crate::services::settings::access::is_locked(app) {
        return Err(crate::services::settings::access::locked_error());
    }
    let params = build_send_to_params(remote, path, sources, cwd);
    log::info!(
        "Executing SendTo transfer: {:?} -> {}:{}",
        params.local_paths,
        params.remote,
        params.path
    );
    crate::rclone::commands::upload::execute_upload_batch(app.clone(), params).await
}

/// Handles `--send-to-remote` for a process that only exists to run the transfer:
/// waits for the engine, uploads, then shuts down gracefully (the host ignores an exit
/// that is not preceded by a shutdown).
pub fn start(app: &crate::context::AppHandle, cli_args: crate::services::cli::GeneralArgs) {
    use crate::services::lifecycle::shutdown::handle_shutdown;
    let Some(remote) = cli_args.send_to_remote else {
        return;
    };
    let app = app.clone();
    crate::utils::spawn(async move {
        // A locked vault never starts the engine; do not wait for it.
        let code = match crate::services::settings::access::is_locked(&app)
            || !wait_for_engine(&app).await
        {
            true => {
                log::error!("SendTo failed: the engine is locked or did not start in time");
                1
            }
            false => match execute(
                &app,
                remote,
                cli_args.send_to_path,
                cli_args.send_to_sources,
                None,
            )
            .await
            {
                Ok(jobid) => {
                    log::info!("SendTo transfer completed successfully. Job ID: {jobid}");
                    0
                }
                Err(e) => {
                    log::error!("SendTo transfer failed: {e}");
                    1
                }
            },
        };
        handle_shutdown(app.clone()).await;
        app.exit(code);
    });
}

/// Polls for up to ten seconds.
async fn wait_for_engine(app: &crate::context::AppHandle) -> bool {
    for _ in 0..100 {
        if crate::rclone::engine::lifecycle::get_engine_status(app)
            .await
            .running
        {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn resolves_relative_sources_against_invoking_directory() {
        let temp = tempfile::tempdir().unwrap();
        let absolute = temp.path().join("absolute.txt");
        let params = build_send_to_params(
            "remote".into(),
            Some("folder/özel".into()),
            vec!["file with spaces.txt".into(), absolute.clone()],
            Some(temp.path()),
        );
        assert_eq!(
            Path::new(&params.local_paths[0]),
            temp.path().join("file with spaces.txt")
        );
        assert_eq!(Path::new(&params.local_paths[1]), absolute);
        assert_eq!(params.path, "folder/özel");
        assert_eq!(params.remote, "remote");
        assert_eq!(params.group.as_deref(), Some("send_to"));
    }

    #[test]
    fn missing_directory_preserves_paths_and_empty_inputs() {
        let params = build_send_to_params("remote".into(), None, vec!["relative.txt".into()], None);
        assert_eq!(params.local_paths, ["relative.txt"]);
        assert!(params.path.is_empty());
        let empty = build_send_to_params(String::new(), None, vec![], None);
        assert!(empty.local_paths.is_empty());
        assert!(empty.remote.is_empty());
    }

    #[tokio::test]
    async fn a_locked_session_refuses_transfers() {
        use crate::services::settings::{access::VaultAccess, schema::AppSettings};
        use std::sync::Arc;

        let directory = tempfile::tempdir().unwrap();
        let manager = rcman::SettingsManager::builder("send-to-test", "1")
            .with_config_dir(directory.path())
            .with_schema::<AppSettings>()
            .build()
            .unwrap();
        let access = Arc::new(VaultAccess::new(directory.path(), &manager).unwrap());
        let app = crate::context::AppHandle::default();
        app.manage(manager);
        app.manage(access.clone());
        access.lock();

        let error = execute(&app, "remote".into(), None, vec!["a.txt".into()], None)
            .await
            .unwrap_err();
        assert_eq!(error, crate::services::settings::access::locked_error());
    }
}
