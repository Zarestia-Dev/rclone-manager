use crate::rclone::commands::upload::UploadBatchParams;

pub(super) fn build_send_to_params(
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
        remote,
        path: path.unwrap_or_default(),
        local_paths,
        origin: Some(crate::utils::types::origin::Origin::FileManager),
        group: Some("send_to".to_string()),
        existing_jobid: None,
        no_cache: false,
    }
}
pub(super) fn start(app: &crate::utils::context::AppHandle, cli_args: crate::core::cli::CliArgs) {
    use crate::rclone::commands::upload::execute_upload_batch;
    if cli_args.general.send_to_remote.is_some() {
        let app_handle_clone = app.clone();
        crate::utils::spawn(async move {
            let mut engine_ready = false;
            for _ in 0..100 {
                let status =
                    crate::rclone::engine::lifecycle::get_engine_status(&app_handle_clone).await;
                if status.running {
                    engine_ready = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }

            if !engine_ready {
                log::error!("SendTo failed: Rclone engine failed to start in time");
                app_handle_clone.exit(1);
                return;
            }

            if let Some(remote) = cli_args.general.send_to_remote {
                let path = cli_args.general.send_to_path;
                let sources = cli_args.general.send_to_sources;
                let params = build_send_to_params(remote, path, sources, None);

                log::info!(
                    "Executing SendTo transfer: {:?} -> {}:{}",
                    params.local_paths,
                    params.remote,
                    params.path
                );

                match execute_upload_batch(app_handle_clone.clone(), params).await {
                    Ok(jobid) => {
                        log::info!("SendTo transfer completed successfully. Job ID: {jobid}");
                    }
                    Err(e) => {
                        log::error!("SendTo transfer failed: {e}");
                    }
                }
            }
            app_handle_clone.exit(0);
        });
    }
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
}
