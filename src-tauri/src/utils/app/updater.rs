#[cfg(desktop)]
pub mod app_updates {
    use log::warn;
    use serde::Serialize;
    use tauri::{AppHandle, Manager, State, ipc::Channel};
    use tauri_plugin_updater::{Update, UpdaterExt};

    use crate::{core::lifecycle::shutdown::handle_shutdown, utils::types::all_types::RcloneState};

    #[derive(Debug, thiserror::Error)]
    pub enum Error {
        #[error(transparent)]
        Updater(#[from] tauri_plugin_updater::Error),
        #[error("there is no pending update")]
        NoPendingUpdate,
        #[error("invalid URL: {0}")]
        InvalidUrl(#[from] url::ParseError),
    }

    impl serde::Serialize for Error {
        fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            serializer.serialize_str(self.to_string().as_str())
        }
    }

    type Result<T> = std::result::Result<T, Error>;

    #[derive(Clone, Serialize)]
    #[serde(tag = "event", content = "data")]
    pub enum DownloadEvent {
        #[serde(rename_all = "camelCase")]
        Started {
            content_length: Option<u64>,
        },
        #[serde(rename_all = "camelCase")]
        Progress {
            chunk_length: usize,
        },
        Finished,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateMetadata {
        version: String,
        current_version: String,
    }

    #[tauri::command]
    pub async fn fetch_update(
        app: AppHandle,
        pending_update: State<'_, PendingUpdate>,
        channel: String,
    ) -> Result<Option<UpdateMetadata>> {
        // Determine endpoint based on channel
        let endpoint = match channel.as_str() {
            "stable" => {
                "https://github.com/Hakanbaban53/rclone-manager/releases/latest/download/latest.json"
            }
            "beta" => {
                "https://github.com/Hakanbaban53/rclone-manager/releases/latest/download/beta.json"
            }
            "nightly" => {
                "https://github.com/Hakanbaban53/rclone-manager/releases/latest/download/nightly.json"
            }
            _ => {
                "https://github.com/Hakanbaban53/rclone-manager/releases/latest/download/latest.json"
            } // default to stable
        };

        let update = app
            .updater_builder()
            .endpoints(vec![endpoint.parse()?])?
            // Allow downgrades by using custom version comparator
            .version_comparator(|current, update| {
                // Allow any version change (including downgrades)
                // Default comparison: update.version > current
                update.version != current
            })
            // Windows-specific: Hook before app exits for update installation
            .on_before_exit({
                move || {
                    let app = app.clone();
                    warn!("App is about to exit on Windows for update installation");
                    tauri::async_runtime::spawn(async move {
                        app.state::<RcloneState>().set_shutting_down();
                        handle_shutdown(app).await;
                    });
                }
            })
            .build()?
            .check()
            .await?;

        let update_metadata = update.as_ref().map(|update| UpdateMetadata {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
        });

        *pending_update.0.lock().unwrap() = update;

        Ok(update_metadata)
    }

    #[tauri::command]
    pub async fn install_update(
        pending_update: State<'_, PendingUpdate>,
        on_event: Channel<DownloadEvent>,
    ) -> Result<()> {
        let Some(update) = pending_update.0.lock().unwrap().take() else {
            return Err(Error::NoPendingUpdate);
        };

        let mut started = false;

        update
            .download_and_install(
                |chunk_length, content_length| {
                    if !started {
                        let _ = on_event.send(DownloadEvent::Started { content_length });
                        started = true;
                    }

                    let _ = on_event.send(DownloadEvent::Progress { chunk_length });
                },
                || {
                    let _ = on_event.send(DownloadEvent::Finished);
                },
            )
            .await?;

        Ok(())
    }

    pub struct PendingUpdate(pub std::sync::Mutex<Option<Update>>);
}
