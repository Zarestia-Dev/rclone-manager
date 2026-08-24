use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

use crate::utils::types::events::PROVISION_PROGRESS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProvisionComponent {
    Rclone,
    MountPlugin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProvisionStage {
    Downloading,
    Verifying,
    Extracting,
    Installing,
    Completed,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionProgressPayload {
    pub component: ProvisionComponent,
    pub stage: ProvisionStage,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionStatus {
    pub rclone: Option<ProvisionProgressPayload>,
    pub mount_plugin: Option<ProvisionProgressPayload>,
}

pub struct ProvisionTokenGuard<'a> {
    token_mutex: &'a Mutex<Option<CancellationToken>>,
    progress_mutex: &'a Mutex<Option<ProvisionProgressPayload>>,
}

impl Drop for ProvisionTokenGuard<'_> {
    fn drop(&mut self) {
        *self.token_mutex.lock() = None;
        *self.progress_mutex.lock() = None;
    }
}

pub struct ProvisionState {
    pub rclone_token: Mutex<Option<CancellationToken>>,
    pub mount_plugin_token: Mutex<Option<CancellationToken>>,
    pub rclone_progress: Mutex<Option<ProvisionProgressPayload>>,
    pub mount_plugin_progress: Mutex<Option<ProvisionProgressPayload>>,
}

impl Default for ProvisionState {
    fn default() -> Self {
        Self {
            rclone_token: Mutex::new(None),
            mount_plugin_token: Mutex::new(None),
            rclone_progress: Mutex::new(None),
            mount_plugin_progress: Mutex::new(None),
        }
    }
}

impl ProvisionState {
    pub fn set_rclone_token(&self, token: CancellationToken) -> ProvisionTokenGuard<'_> {
        *self.rclone_token.lock() = Some(token);
        ProvisionTokenGuard {
            token_mutex: &self.rclone_token,
            progress_mutex: &self.rclone_progress,
        }
    }

    pub fn set_mount_plugin_token(&self, token: CancellationToken) -> ProvisionTokenGuard<'_> {
        *self.mount_plugin_token.lock() = Some(token);
        ProvisionTokenGuard {
            token_mutex: &self.mount_plugin_token,
            progress_mutex: &self.mount_plugin_progress,
        }
    }

    pub fn update_progress(
        &self,
        app_handle: &tauri::AppHandle,
        payload: ProvisionProgressPayload,
    ) {
        let is_terminal = matches!(
            payload.stage,
            ProvisionStage::Completed | ProvisionStage::Cancelled | ProvisionStage::Error
        );

        match payload.component {
            ProvisionComponent::Rclone => {
                *self.rclone_progress.lock() = if is_terminal {
                    None
                } else {
                    Some(payload.clone())
                };
            }
            ProvisionComponent::MountPlugin => {
                *self.mount_plugin_progress.lock() = if is_terminal {
                    None
                } else {
                    Some(payload.clone())
                };
            }
        }

        let _ = app_handle.emit(PROVISION_PROGRESS, payload);
    }

    pub fn set_stage(
        &self,
        app_handle: &tauri::AppHandle,
        component: ProvisionComponent,
        stage: ProvisionStage,
        bytes: u64,
        error: Option<String>,
    ) {
        self.update_progress(
            app_handle,
            ProvisionProgressPayload {
                component,
                stage,
                downloaded_bytes: bytes,
                total_bytes: if bytes > 0 { Some(bytes) } else { None },
                error,
            },
        );
    }

    pub fn get_progress(&self, component: ProvisionComponent) -> Option<ProvisionProgressPayload> {
        match component {
            ProvisionComponent::Rclone => self.rclone_progress.lock().clone(),
            ProvisionComponent::MountPlugin => self.mount_plugin_progress.lock().clone(),
        }
    }

    pub fn get_status(&self) -> ProvisionStatus {
        ProvisionStatus {
            rclone: self.get_progress(ProvisionComponent::Rclone),
            mount_plugin: self.get_progress(ProvisionComponent::MountPlugin),
        }
    }

    pub fn cancel_rclone(&self) -> bool {
        if let Some(token) = self.rclone_token.lock().take() {
            token.cancel();
            *self.rclone_progress.lock() = None;
            true
        } else {
            false
        }
    }

    pub fn cancel_mount_plugin(&self) -> bool {
        if let Some(token) = self.mount_plugin_token.lock().take() {
            token.cancel();
            *self.mount_plugin_progress.lock() = None;
            true
        } else {
            false
        }
    }
}
