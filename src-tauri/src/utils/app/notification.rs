//! Typed notification system.
//!
//! # Usage
//!
//! ```rust,ignore
//! notify(&app, NotificationEvent::JobCompleted {
//!     remote: "gdrive:".into(),
//!     profile: Some("backup".into()),
//!     job_type: JobType::Sync,
//!     origin: Origin::Dashboard,
//! });
//! ```
//!
//! # Design
//!
//! The single entry point is [`notify`]. It renders i18n text once, emits
//! a structured log, and hands off to the alert engine which handles OS
//! delivery, webhooks, scripts, and history.

use log::{debug, error, info, trace, warn};

use crate::utils::types::{jobs::JobType, logs::LogLevel, origin::Origin};

// ---------------------------------------------------------------------------
// Public event type
// ---------------------------------------------------------------------------

/// Every OS notification the application can emit.
///
/// Each variant is self-contained: it carries all the data needed to render
/// the notification text and determine whether to suppress the toast.
#[derive(Debug)]
pub enum NotificationEvent {
    // -- Job lifecycle -------------------------------------------------------
    JobCompleted {
        remote: String,
        profile: Option<String>,
        job_type: JobType,
        origin: Origin,
    },
    JobStarted {
        remote: String,
        profile: Option<String>,
        job_type: JobType,
        origin: Origin,
    },
    /// Always shown — errors are never suppressed regardless of origin.
    JobFailed {
        remote: String,
        profile: Option<String>,
        job_type: JobType,
        error: String,
        origin: Origin,
    },
    JobStopped {
        remote: String,
        profile: Option<String>,
        job_type: JobType,
        origin: Origin,
    },

    // -- Serve lifecycle -----------------------------------------------------
    ServeStarted {
        remote: String,
        profile: Option<String>,
        addr: String,
        origin: Origin,
    },
    /// Always shown.
    ServeFailed {
        remote: String,
        profile: Option<String>,
        error: String,
        origin: Origin,
    },
    ServeStopped {
        remote: String,
        profile: Option<String>,
        origin: Origin,
    },
    NothingToDoServes,
    AllServesStopped,

    // -- Mount lifecycle -----------------------------------------------------
    MountSucceeded {
        remote: String,
        profile: Option<String>,
        mount_point: String,
        origin: Origin,
    },
    /// Always shown.
    MountFailed {
        mount_point: String,
        error: String,
    },
    UnmountSucceeded {
        remote: String,
        profile: String,
        origin: Origin,
    },
    AllUnmounted,
    NothingToUnmount,
    NothingToDoJobs,
    AllJobsStopped {
        count: String,
    },

    // -- Engine / connectivity -----------------------------------------------
    EnginePasswordRequired {
        remote: String,
    },
    EngineBinaryNotFound,
    EngineConnectionFailed {
        reason: String,
    },
    EngineRestarted {
        reason: String,
    },
    EngineRestartFailed {
        reason: String,
    },

    // -- Updates -------------------------------------------------------------
    AppUpdateAvailable {
        version: String,
    },
    AppUpdateStarted {
        version: String,
    },
    AppUpdateComplete {
        version: String,
    },
    AppUpdateFailed {
        error: String,
    },
    AppUpdateInstalled {
        version: String,
    },
    RcloneUpdateAvailable {
        version: String,
    },
    RcloneUpdateStarted {
        version: String,
    },
    RcloneUpdateComplete {
        version: String,
    },
    RcloneUpdateFailed {
        error: String,
    },
    RcloneUpdateInstalled {
        version: String,
    },

    AlreadyRunning,

    // -- Scheduled tasks -----------------------------------------------------
    ScheduledTaskStarted {
        task_name: String,
    },
    ScheduledTaskCompleted {
        task_name: String,
    },
    ScheduledTaskFailed {
        task_name: String,
        error: String,
    },
}

// ---------------------------------------------------------------------------
// Suppression policy
// ---------------------------------------------------------------------------

/// Whether an event can be suppressed when the app window is focused.
///
/// This is the *event-level floor*. Rule-level `suppress_when_focused` can
/// only suppress events that return `WhenFocused` here — it can never silence
/// `Never` events regardless of how a rule is configured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Suppression {
    /// Always deliver the OS toast.
    Never,
    /// OK to omit while the main window is focused.
    WhenFocused,
}

impl NotificationEvent {
    /// The event's own suppression floor.
    ///
    /// Exposed as `pub` so the alert engine can enforce it in Gate 6
    /// without duplicating the match arms.
    #[must_use]
    pub fn suppression(&self) -> Suppression {
        match self {
            // Critical engine/auth failures: never silent.
            Self::EnginePasswordRequired { .. }
            | Self::EngineBinaryNotFound
            | Self::EngineConnectionFailed { .. } => Suppression::Never,

            // All failures surface regardless of who triggered them.
            Self::JobFailed { .. }
            | Self::MountFailed { .. }
            | Self::ServeFailed { .. }
            | Self::EngineRestartFailed { .. } => Suppression::Never,

            // Updates: always surface; the in-app badge may be easy to miss.
            Self::AppUpdateAvailable { .. }
            | Self::AppUpdateStarted { .. }
            | Self::AppUpdateComplete { .. }
            | Self::AppUpdateFailed { .. }
            | Self::AppUpdateInstalled { .. }
            | Self::RcloneUpdateAvailable { .. }
            | Self::RcloneUpdateStarted { .. }
            | Self::RcloneUpdateComplete { .. }
            | Self::RcloneUpdateFailed { .. }
            | Self::RcloneUpdateInstalled { .. } => Suppression::Never,

            // Scheduled tasks run entirely in the background — always show.
            Self::ScheduledTaskStarted { .. }
            | Self::ScheduledTaskCompleted { .. }
            | Self::ScheduledTaskFailed { .. } => Suppression::Never,

            // Engine restart is informational but important enough to always show.
            Self::EngineRestarted { .. } => Suppression::Never,

            // User-initiated ops: if the user is still in the app they can see
            // the result. Background/scheduler origins bypass this in event_ext.
            Self::JobCompleted { .. }
            | Self::JobStarted { .. }
            | Self::JobStopped { .. }
            | Self::MountSucceeded { .. }
            | Self::UnmountSucceeded { .. }
            | Self::ServeStarted { .. }
            | Self::ServeStopped { .. }
            | Self::AllUnmounted
            | Self::NothingToUnmount
            | Self::AllServesStopped
            | Self::NothingToDoServes
            | Self::AllJobsStopped { .. }
            | Self::NothingToDoJobs
            | Self::AlreadyRunning => Suppression::WhenFocused,
        }
    }
}

// ---------------------------------------------------------------------------
// Rendering: i18n translation + log level
// ---------------------------------------------------------------------------

struct RenderedContent {
    title: String,
    body: String,
    level: LogLevel,
}

impl NotificationEvent {
    /// Translate the event into display strings and a log level.
    fn render(&self) -> RenderedContent {
        use crate::utils::i18n::{t, t_with_params};

        match self {
            Self::JobCompleted {
                remote,
                profile,
                job_type,
                ..
            } => {
                let operation = job_type.to_string();
                RenderedContent {
                    title: t_with_params(
                        "notification.title.operationComplete",
                        &[("operation", &operation)],
                    ),
                    body: t_with_params(
                        "notification.body.complete",
                        &[
                            ("operation", &operation),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                        ],
                    ),
                    level: LogLevel::Info,
                }
            }

            Self::JobStarted {
                remote,
                profile,
                job_type,
                ..
            } => {
                let operation = job_type.to_string();
                RenderedContent {
                    title: t_with_params(
                        "notification.title.operationStarted",
                        &[("operation", &operation)],
                    ),
                    body: t_with_params(
                        "notification.body.started",
                        &[
                            ("operation", &operation),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                        ],
                    ),
                    level: LogLevel::Info,
                }
            }

            Self::JobFailed {
                remote,
                profile,
                job_type,
                error,
                ..
            } => {
                let operation = job_type.to_string();
                RenderedContent {
                    title: t_with_params(
                        "notification.title.operationFailed",
                        &[("operation", &operation), ("error", error)],
                    ),
                    body: t_with_params(
                        "notification.body.failed",
                        &[
                            ("operation", &operation),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                            ("error", error),
                        ],
                    ),
                    level: LogLevel::Error,
                }
            }

            Self::JobStopped {
                remote,
                profile,
                job_type,
                ..
            } => {
                let operation = job_type.to_string();
                RenderedContent {
                    title: t_with_params(
                        "notification.title.operationStopped",
                        &[("operation", &operation)],
                    ),
                    body: t_with_params(
                        "notification.body.stopped",
                        &[
                            ("operation", &operation),
                            ("remote", remote),
                            ("profile", profile.as_deref().unwrap_or("")),
                        ],
                    ),
                    level: LogLevel::Info,
                }
            }

            Self::ServeStarted {
                remote,
                profile,
                addr,
                ..
            } => RenderedContent {
                title: t("notification.title.serveStarted"),
                body: t_with_params(
                    "notification.body.serveStarted",
                    &[
                        ("remote", remote),
                        ("profile", profile.as_deref().unwrap_or("")),
                        ("addr", addr),
                    ],
                ),
                level: LogLevel::Info,
            },

            Self::ServeFailed {
                remote,
                profile,
                error,
                ..
            } => RenderedContent {
                title: t("notification.title.serveFailed"),
                body: t_with_params(
                    "notification.body.serveFailed",
                    &[
                        ("remote", remote),
                        ("profile", profile.as_deref().unwrap_or("")),
                        ("error", error),
                    ],
                ),
                level: LogLevel::Error,
            },

            Self::ServeStopped {
                remote, profile, ..
            } => RenderedContent {
                title: t("notification.title.serveStopped"),
                body: t_with_params(
                    "notification.body.serveStopped",
                    &[
                        ("remote", remote),
                        ("profile", profile.as_deref().unwrap_or("")),
                    ],
                ),
                level: LogLevel::Info,
            },

            Self::MountSucceeded {
                remote,
                profile,
                mount_point,
                ..
            } => RenderedContent {
                title: t("notification.title.mountSuccess"),
                body: t_with_params(
                    "notification.body.mounted",
                    &[
                        ("remote", remote),
                        ("profile", profile.as_deref().unwrap_or("")),
                        ("mountPoint", mount_point),
                    ],
                ),
                level: LogLevel::Info,
            },

            Self::MountFailed { mount_point, error } => RenderedContent {
                title: t("notification.title.mountFailed"),
                body: t_with_params(
                    "notification.body.mountFailed",
                    &[("mountPoint", mount_point), ("error", error)],
                ),
                level: LogLevel::Error,
            },

            Self::UnmountSucceeded {
                remote, profile, ..
            } => RenderedContent {
                title: t("notification.title.unmountSuccess"),
                body: t_with_params(
                    "notification.body.unmounted",
                    &[("remote", remote), ("profile", profile)],
                ),
                level: LogLevel::Info,
            },

            Self::AllUnmounted => RenderedContent {
                title: t("notification.title.unmountSuccess"),
                body: t("notification.body.allRemotesUnmounted"),
                level: LogLevel::Info,
            },

            Self::AllServesStopped => RenderedContent {
                title: t("notification.title.allServesStopped"),
                body: t("notification.body.allServesStopped"),
                level: LogLevel::Info,
            },

            Self::AlreadyRunning => RenderedContent {
                title: t("notification.title.alreadyRunning"),
                body: t("notification.body.alreadyRunning"),
                level: LogLevel::Info,
            },

            Self::NothingToUnmount => RenderedContent {
                title: t("notification.title.nothingToDo"),
                body: t("notification.body.nothingToDoMounts"),
                level: LogLevel::Info,
            },

            Self::NothingToDoServes => RenderedContent {
                title: t("notification.title.nothingToDo"),
                body: t("notification.body.nothingToDoServes"),
                level: LogLevel::Info,
            },

            Self::NothingToDoJobs => RenderedContent {
                title: t("notification.title.nothingToDo"),
                body: t("notification.body.nothingToDoJobs"),
                level: LogLevel::Info,
            },

            Self::AllJobsStopped { count } => RenderedContent {
                title: t("notification.title.allJobsStopped"),
                body: t_with_params("notification.body.allJobsStopped", &[("count", count)]),
                level: LogLevel::Info,
            },

            Self::EnginePasswordRequired { remote } => RenderedContent {
                title: t("notification.title.engineError"),
                body: t_with_params(
                    "notification.body.enginePasswordError",
                    &[("remote", remote)],
                ),
                level: LogLevel::Error,
            },

            Self::EngineBinaryNotFound => RenderedContent {
                title: t("notification.title.engineError"),
                body: t("notification.body.enginePathError"),
                level: LogLevel::Error,
            },

            Self::EngineConnectionFailed { reason } => RenderedContent {
                title: t("notification.title.engineError"),
                body: t_with_params("notification.body.connectionFailed", &[("reason", reason)]),
                level: LogLevel::Error,
            },

            Self::EngineRestarted { reason } => RenderedContent {
                title: t("notification.title.engineRestarted"),
                body: t_with_params(
                    "notification.body.engineRestartedSuccess",
                    &[("reason", reason)],
                ),
                level: LogLevel::Info,
            },

            Self::EngineRestartFailed { reason } => RenderedContent {
                title: t("notification.title.engineError"),
                body: t_with_params(
                    "notification.body.engineRestartedFailed",
                    &[("reason", reason)],
                ),
                level: LogLevel::Error,
            },

            Self::AppUpdateAvailable { version } => RenderedContent {
                title: t("notification.title.updateFound"),
                body: t_with_params("notification.body.updateFound", &[("version", version)]),
                level: LogLevel::Info,
            },

            Self::AppUpdateStarted { version } => RenderedContent {
                title: t("notification.title.updateStarted"),
                body: t_with_params("notification.body.updateStarted", &[("version", version)]),
                level: LogLevel::Info,
            },

            Self::AppUpdateComplete { version } => RenderedContent {
                title: t("notification.title.updateComplete"),
                body: t_with_params("notification.body.updateComplete", &[("version", version)]),
                level: LogLevel::Info,
            },

            Self::AppUpdateFailed { error } => RenderedContent {
                title: t("notification.title.updateFailed"),
                body: t_with_params("notification.body.updateFailed", &[("error", error)]),
                level: LogLevel::Error,
            },

            Self::AppUpdateInstalled { version } => RenderedContent {
                title: t("notification.title.updateInstalled"),
                body: t_with_params("notification.body.updateInstalled", &[("version", version)]),
                level: LogLevel::Info,
            },

            Self::RcloneUpdateAvailable { version } => RenderedContent {
                title: t("notification.title.rcloneUpdateFound"),
                body: t_with_params(
                    "notification.body.rcloneUpdateFound",
                    &[("version", version)],
                ),
                level: LogLevel::Info,
            },

            Self::RcloneUpdateStarted { version } => RenderedContent {
                title: t("notification.title.rcloneUpdateStarted"),
                body: t_with_params(
                    "notification.body.rcloneUpdateStarted",
                    &[("version", version)],
                ),
                level: LogLevel::Info,
            },

            Self::RcloneUpdateComplete { version } => RenderedContent {
                title: t("notification.title.rcloneUpdateComplete"),
                body: t_with_params(
                    "notification.body.rcloneUpdateComplete",
                    &[("version", version)],
                ),
                level: LogLevel::Info,
            },

            Self::RcloneUpdateFailed { error } => RenderedContent {
                title: t("notification.title.rcloneUpdateFailed"),
                body: t_with_params("notification.body.rcloneUpdateFailed", &[("error", error)]),
                level: LogLevel::Error,
            },

            Self::RcloneUpdateInstalled { version } => RenderedContent {
                title: t("notification.title.rcloneUpdateInstalled"),
                body: t_with_params(
                    "notification.body.rcloneUpdateInstalled",
                    &[("version", version)],
                ),
                level: LogLevel::Info,
            },

            Self::ScheduledTaskStarted { task_name } => RenderedContent {
                title: t("notification.title.scheduledTaskStarted"),
                body: t_with_params(
                    "notification.body.scheduledTaskStarted",
                    &[("task", task_name)],
                ),
                level: LogLevel::Info,
            },

            Self::ScheduledTaskCompleted { task_name } => RenderedContent {
                title: t("notification.title.scheduledTaskCompleted"),
                body: t_with_params(
                    "notification.body.scheduledTaskCompleted",
                    &[("task", task_name)],
                ),
                level: LogLevel::Info,
            },

            Self::ScheduledTaskFailed { task_name, error } => RenderedContent {
                title: t("notification.title.scheduledTaskFailed"),
                body: t_with_params(
                    "notification.body.scheduledTaskFailed",
                    &[("task", task_name), ("error", error)],
                ),
                level: LogLevel::Error,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Emit a notification.
///
/// Renders i18n text once, emits a structured log, then hands off to the
/// alert engine for rule matching, action dispatch, and history recording.
///
/// This is the only function call sites should use.
pub fn notify(app: &tauri::AppHandle, event: NotificationEvent) {
    let RenderedContent { title, body, level } = event.render();

    emit_log(level, &title, &body);

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // Pass the already-rendered strings so the engine doesn't have to
        // re-derive them (and can't drift from this implementation).
        crate::core::alerts::engine::process(&app_handle, &event, title, body);
    });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

fn emit_log(level: LogLevel, title: &str, body: &str) {
    match level {
        LogLevel::Error => error!("🔔 {title} — {body}"),
        LogLevel::Warn => warn!("🔔 {title} — {body}"),
        LogLevel::Info => info!("🔔 {title} — {body}"),
        LogLevel::Debug => debug!("🔔 {title} — {body}"),
        LogLevel::Trace => trace!("🔔 {title} — {body}"),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_errors_are_never_suppressed() {
        assert_eq!(
            NotificationEvent::EnginePasswordRequired {
                remote: "gdrive:".into()
            }
            .suppression(),
            Suppression::Never,
        );
        assert_eq!(
            NotificationEvent::EngineBinaryNotFound.suppression(),
            Suppression::Never
        );
        assert_eq!(
            NotificationEvent::EngineConnectionFailed {
                reason: "timeout".into()
            }
            .suppression(),
            Suppression::Never,
        );
    }

    #[test]
    fn failures_are_never_suppressed() {
        assert_eq!(
            NotificationEvent::JobFailed {
                remote: "s3:".into(),
                profile: None,
                job_type: JobType::Sync,
                error: "permission denied".into(),
                origin: Origin::Dashboard,
            }
            .suppression(),
            Suppression::Never,
        );
        assert_eq!(
            NotificationEvent::MountFailed {
                mount_point: "/mnt/r".into(),
                error: "fuse unavailable".into(),
            }
            .suppression(),
            Suppression::Never,
        );
    }

    #[test]
    fn user_initiated_completions_are_suppressible() {
        assert_eq!(
            NotificationEvent::JobCompleted {
                remote: "gdrive:".into(),
                profile: Some("backup".into()),
                job_type: JobType::Sync,
                origin: Origin::Dashboard,
            }
            .suppression(),
            Suppression::WhenFocused,
        );
    }

    #[test]
    fn scheduled_and_update_events_are_never_suppressed() {
        assert_eq!(
            NotificationEvent::ScheduledTaskStarted {
                task_name: "nightly".into()
            }
            .suppression(),
            Suppression::Never,
        );
        assert_eq!(
            NotificationEvent::ScheduledTaskCompleted {
                task_name: "nightly".into()
            }
            .suppression(),
            Suppression::Never,
        );
        assert_eq!(
            NotificationEvent::AppUpdateAvailable {
                version: "2.0.0".into()
            }
            .suppression(),
            Suppression::Never,
        );
    }
}
