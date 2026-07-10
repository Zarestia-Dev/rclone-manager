use log::{debug, error, info, trace, warn};
use serde::{Deserialize, Serialize};

use crate::utils::i18n::{t, t_with_params};
use crate::utils::types::jobs::JobType;
use crate::utils::types::logs::LogLevel;
use crate::utils::types::origin::Origin;

// Hierarchical Event Data Structures

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", content = "data", rename_all = "snake_case")]
pub enum UpdateStage {
    Available { version: String },
    Started { version: String },
    Downloaded { version: String },
    Complete { version: String },
    Failed { error: String },
    Installed { version: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", content = "data", rename_all = "snake_case")]
pub enum JobStage {
    Started {
        backend: String,
        remote: String,
        profile: Option<String>,
        job_type: JobType,
        origin: Origin,
        source: Option<String>,
        destination: Option<String>,
    },
    Completed {
        backend: String,
        remote: String,
        profile: Option<String>,
        job_type: JobType,
        origin: Origin,
        source: Option<String>,
        destination: Option<String>,
    },
    Failed {
        backend: String,
        remote: String,
        profile: Option<String>,
        job_type: JobType,
        error: String,
        origin: Origin,
        source: Option<String>,
        destination: Option<String>,
    },
    Stopped {
        backend: String,
        remote: String,
        profile: Option<String>,
        job_type: JobType,
        origin: Origin,
        source: Option<String>,
        destination: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", content = "data", rename_all = "snake_case")]
pub enum AutomationStage {
    Started {
        backend: String,
        remote: String,
        profile: String,
        automation_name: String,
        automation_type: crate::utils::types::remotes::OperationType,
    },
    Completed {
        backend: String,
        remote: String,
        profile: String,
        automation_name: String,
        automation_type: crate::utils::types::remotes::OperationType,
    },
    Failed {
        backend: String,
        remote: String,
        profile: String,
        automation_name: String,
        automation_type: crate::utils::types::remotes::OperationType,
        error: String,
    },
    Stopped {
        backend: String,
        remote: String,
        profile: String,
        automation_name: String,
        automation_type: crate::utils::types::remotes::OperationType,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", content = "data", rename_all = "snake_case")]
pub enum ServeStage {
    Started {
        backend: String,
        remote: String,
        profile: Option<String>,
        protocol: String,
    },
    Failed {
        backend: String,
        remote: String,
        profile: Option<String>,
        protocol: String,
        error: String,
    },
    Stopped {
        backend: String,
        remote: String,
        profile: Option<String>,
        protocol: String,
    },
    AllStopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", content = "data", rename_all = "snake_case")]
pub enum MountStage {
    Succeeded {
        backend: String,
        remote: String,
        profile: Option<String>,
        mount_point: String,
    },
    Failed {
        backend: String,
        remote: String,
        profile: Option<String>,
        error: String,
    },
    UnmountSucceeded {
        backend: String,
        remote: String,
        profile: Option<String>,
    },
    AllUnmounted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", content = "data", rename_all = "snake_case")]
pub enum EngineStage {
    PasswordRequired,
    BinaryNotFound,
    ConnectionFailed { error: String },
    Restarted,
    RestartFailed { error: String },
}

// Main Notification Event Enum

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "domain", content = "event", rename_all = "snake_case")]
pub enum NotificationEvent {
    Job(JobStage),
    Automation(AutomationStage),
    AppUpdate(UpdateStage),
    RcloneUpdate(UpdateStage),
    Serve(ServeStage),
    Mount(MountStage),
    Engine(EngineStage),
    System(SystemStage),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "stage", content = "data", rename_all = "snake_case")]
pub enum SystemStage {
    AllJobsStopped,
}

// Rendering Logic

pub struct RenderedContent {
    pub title: String,
    pub body: String,
    pub level: LogLevel,
}

impl NotificationEvent {
    #[must_use]
    pub fn render(&self) -> RenderedContent {
        match self {
            // --- JOB DOMAIN ---
            Self::Job(stage) => match stage {
                JobStage::Started {
                    backend,
                    remote,
                    profile,
                    job_type,
                    ..
                } => RenderedContent {
                    title: t_with_params(
                        "notification.title.jobStarted",
                        &[("type", &job_type.to_string())],
                    ),
                    body: t_with_params(
                        "notification.body.jobStarted",
                        &[
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                            ("type", &job_type.to_string().to_lowercase()),
                        ],
                    ),
                    level: LogLevel::Info,
                },
                JobStage::Completed {
                    backend,
                    remote,
                    profile,
                    job_type,
                    ..
                } => RenderedContent {
                    title: t_with_params(
                        "notification.title.jobCompleted",
                        &[("type", &job_type.to_string())],
                    ),
                    body: t_with_params(
                        "notification.body.jobCompleted",
                        &[
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                            ("type", &job_type.to_string().to_lowercase()),
                        ],
                    ),
                    level: LogLevel::Info,
                },
                JobStage::Failed {
                    backend,
                    remote,
                    profile,
                    job_type,
                    error,
                    ..
                } => RenderedContent {
                    title: t_with_params(
                        "notification.title.jobFailed",
                        &[("type", &job_type.to_string())],
                    ),
                    body: t_with_params(
                        "notification.body.jobFailed",
                        &[
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                            ("type", &job_type.to_string().to_lowercase()),
                            ("error", error),
                        ],
                    ),
                    level: LogLevel::Error,
                },
                JobStage::Stopped {
                    backend,
                    remote,
                    profile,
                    job_type,
                    ..
                } => RenderedContent {
                    title: t_with_params(
                        "notification.title.jobStopped",
                        &[("type", &job_type.to_string())],
                    ),
                    body: t_with_params(
                        "notification.body.jobStopped",
                        &[
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                            ("type", &job_type.to_string().to_lowercase()),
                        ],
                    ),
                    level: LogLevel::Warn,
                },
            },

            // --- AUTOMATION DOMAIN ---
            Self::Automation(stage) => match stage {
                AutomationStage::Started {
                    automation_name,
                    backend,
                    remote,
                    profile,
                    automation_type,
                } => RenderedContent {
                    title: t_with_params(
                        "notification.title.automationStarted",
                        &[("type", &automation_type.to_string())],
                    ),
                    body: t_with_params(
                        "notification.body.automationStarted",
                        &[
                            ("automation", automation_name),
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile),
                            ("type", &automation_type.to_string().to_lowercase()),
                        ],
                    ),
                    level: LogLevel::Info,
                },
                AutomationStage::Completed {
                    automation_name,
                    backend,
                    remote,
                    profile,
                    automation_type,
                } => RenderedContent {
                    title: t_with_params(
                        "notification.title.automationCompleted",
                        &[("type", &automation_type.to_string())],
                    ),
                    body: t_with_params(
                        "notification.body.automationCompleted",
                        &[
                            ("automation", automation_name),
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile),
                            ("type", &automation_type.to_string().to_lowercase()),
                        ],
                    ),
                    level: LogLevel::Info,
                },
                AutomationStage::Failed {
                    automation_name,
                    backend,
                    profile,
                    remote,
                    automation_type,
                    error,
                } => RenderedContent {
                    title: t_with_params(
                        "notification.title.automationFailed",
                        &[("type", &automation_type.to_string())],
                    ),
                    body: t_with_params(
                        "notification.body.automationFailed",
                        &[
                            ("automation", automation_name),
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile),
                            ("type", &automation_type.to_string().to_lowercase()),
                            ("error", error),
                        ],
                    ),
                    level: LogLevel::Error,
                },
                AutomationStage::Stopped {
                    automation_name,
                    backend,
                    remote,
                    profile,
                    automation_type,
                } => RenderedContent {
                    title: t_with_params(
                        "notification.title.automationStopped",
                        &[("type", &automation_type.to_string())],
                    ),
                    body: t_with_params(
                        "notification.body.automationStopped",
                        &[
                            ("automation", automation_name),
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile),
                            ("type", &automation_type.to_string().to_lowercase()),
                        ],
                    ),
                    level: LogLevel::Warn,
                },
            },

            // --- UPDATE DOMAIN (APP) ---
            Self::AppUpdate(stage) => render_update(stage, "update"),

            // --- UPDATE DOMAIN (RCLONE) ---
            Self::RcloneUpdate(stage) => render_update(stage, "rcloneUpdate"),

            // --- SERVE DOMAIN ---
            Self::Serve(stage) => match stage {
                ServeStage::Started {
                    backend,
                    remote,
                    profile,
                    protocol,
                } => RenderedContent {
                    title: t("notification.title.serveStarted"),
                    body: t_with_params(
                        "notification.body.serveStarted",
                        &[
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                            ("protocol", protocol),
                        ],
                    ),
                    level: LogLevel::Info,
                },
                ServeStage::Failed {
                    backend,
                    remote,
                    profile,
                    protocol,
                    error,
                } => RenderedContent {
                    title: t("notification.title.serveFailed"),
                    body: t_with_params(
                        "notification.body.serveFailed",
                        &[
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                            ("protocol", protocol),
                            ("error", error),
                        ],
                    ),
                    level: LogLevel::Error,
                },
                ServeStage::Stopped {
                    backend,
                    remote,
                    profile,
                    protocol,
                } => RenderedContent {
                    title: t("notification.title.serveStopped"),
                    body: t_with_params(
                        "notification.body.serveStopped",
                        &[
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                            ("protocol", protocol),
                        ],
                    ),
                    level: LogLevel::Warn,
                },
                ServeStage::AllStopped => RenderedContent {
                    title: t("notification.title.allServesStopped"),
                    body: t("notification.body.allServesStopped"),
                    level: LogLevel::Warn,
                },
            },

            // --- MOUNT DOMAIN ---
            Self::Mount(stage) => match stage {
                MountStage::Succeeded {
                    backend,
                    remote,
                    profile,
                    mount_point,
                } => RenderedContent {
                    title: t("notification.title.mountSucceeded"),
                    body: t_with_params(
                        "notification.body.mountSucceeded",
                        &[
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                            ("mountPoint", mount_point),
                        ],
                    ),
                    level: LogLevel::Info,
                },
                MountStage::Failed {
                    backend,
                    remote,
                    profile,
                    error,
                } => RenderedContent {
                    title: t("notification.title.mountFailed"),
                    body: t_with_params(
                        "notification.body.mountFailed",
                        &[
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                            ("error", error),
                        ],
                    ),
                    level: LogLevel::Error,
                },
                MountStage::UnmountSucceeded {
                    backend,
                    remote,
                    profile,
                } => RenderedContent {
                    title: t("notification.title.unmountSucceeded"),
                    body: t_with_params(
                        "notification.body.unmountSucceeded",
                        &[
                            ("backend", backend),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                        ],
                    ),
                    level: LogLevel::Warn,
                },
                MountStage::AllUnmounted => RenderedContent {
                    title: t("notification.title.allUnmounted"),
                    body: t("notification.body.allUnmounted"),
                    level: LogLevel::Warn,
                },
            },

            // --- ENGINE DOMAIN ---
            Self::Engine(stage) => match stage {
                EngineStage::PasswordRequired => RenderedContent {
                    title: t("notification.title.enginePasswordRequired"),
                    body: t("notification.body.enginePasswordRequired"),
                    level: LogLevel::Warn,
                },
                EngineStage::BinaryNotFound => RenderedContent {
                    title: t("notification.title.engineBinaryNotFound"),
                    body: t("notification.body.engineBinaryNotFound"),
                    level: LogLevel::Error,
                },
                EngineStage::ConnectionFailed { error } => RenderedContent {
                    title: t("notification.title.engineConnectionFailed"),
                    body: t_with_params(
                        "notification.body.engineConnectionFailed",
                        &[("error", error)],
                    ),
                    level: LogLevel::Error,
                },
                EngineStage::Restarted => RenderedContent {
                    title: t("notification.title.engineRestarted"),
                    body: t("notification.body.engineRestarted"),
                    level: LogLevel::Info,
                },
                EngineStage::RestartFailed { error } => RenderedContent {
                    title: t("notification.title.engineRestartFailed"),
                    body: t_with_params(
                        "notification.body.engineRestartFailed",
                        &[("error", error)],
                    ),
                    level: LogLevel::Error,
                },
            },

            // --- SYSTEM DOMAIN ---
            Self::System(stage) => match stage {
                SystemStage::AllJobsStopped => RenderedContent {
                    title: t("notification.title.allJobsStopped"),
                    body: t("notification.body.allJobsStopped"),
                    level: LogLevel::Warn,
                },
            },
        }
    }
}

// Public API

pub fn notify(app: &tauri::AppHandle, event: NotificationEvent) {
    let RenderedContent { title, body, level } = event.render();

    emit_log(level, &title, &body);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::core::alerts::engine::process(&app_handle, &event, title, body);
    });
}

fn render_update(stage: &UpdateStage, key_prefix: &str) -> RenderedContent {
    match stage {
        UpdateStage::Available { version } => RenderedContent {
            title: t(&format!("notification.title.{key_prefix}Found")),
            body: t_with_params(
                &format!("notification.body.{key_prefix}Found"),
                &[("version", version)],
            ),
            level: LogLevel::Info,
        },
        UpdateStage::Started { version } => RenderedContent {
            title: t(&format!("notification.title.{key_prefix}Started")),
            body: t_with_params(
                &format!("notification.body.{key_prefix}Started"),
                &[("version", version)],
            ),
            level: LogLevel::Info,
        },
        UpdateStage::Downloaded { version } => RenderedContent {
            title: t(&format!("notification.title.{key_prefix}Downloaded")),
            body: t_with_params(
                &format!("notification.body.{key_prefix}Downloaded"),
                &[("version", version)],
            ),
            level: LogLevel::Info,
        },
        UpdateStage::Complete { version } => RenderedContent {
            title: t(&format!("notification.title.{key_prefix}Complete")),
            body: t_with_params(
                &format!("notification.body.{key_prefix}Complete"),
                &[("version", version)],
            ),
            level: LogLevel::Info,
        },
        UpdateStage::Failed { error } => RenderedContent {
            title: t(&format!("notification.title.{key_prefix}Failed")),
            body: t_with_params(
                &format!("notification.body.{key_prefix}Failed"),
                &[("error", error)],
            ),
            level: LogLevel::Error,
        },
        UpdateStage::Installed { version } => RenderedContent {
            title: t(&format!("notification.title.{key_prefix}Installed")),
            body: t_with_params(
                &format!("notification.body.{key_prefix}Installed"),
                &[("version", version)],
            ),
            level: LogLevel::Info,
        },
    }
}

fn emit_log(level: LogLevel, title: &str, body: &str) {
    match level {
        LogLevel::Error => error!("🔔 {title} — {body}"),
        LogLevel::Warn => warn!("🔔 {title} — {body}"),
        LogLevel::Info => info!("🔔 {title} — {body}"),
        LogLevel::Debug => debug!("🔔 {title} — {body}"),
        LogLevel::Trace => trace!("🔔 {title} — {body}"),
    }
}
