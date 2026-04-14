//! Typed notification system.
//!
//! # Usage
//!
//! ```rust,ignore
//! notify(&app, NotificationEvent::JobCompleted {
//!     remote: "gdrive:".into(),
//!     profile: Some("backup".into()),
//!     operation: "Sync".into(),
//!     origin: Origin::Ui,
//! });
//! ```
//!
//! # Design
//!
//! The single entry point is [`notify`]. Suppression policy, i18n translation,
//! log emission, and OS delivery are all handled internally.
//!
//! **Suppression is derived from the event variant**, not from the caller.
//! This means a [`NotificationEvent::EnginePasswordRequired`] can never be
//! silenced by a careless `origin` argument, and a scheduler-triggered job
//! completion is always surfaced to the user even if the app is focused.
//!
//! | Event family                      | Suppressed when focused? |
//! |-----------------------------------|--------------------------|
//! | Engine errors                     | Never                    |
//! | Job / mount **failures**          | Never                    |
//! | App / rclone updates              | Never                    |
//! | Scheduler-triggered completions   | Never                    |
//! | User-initiated op completions     | Yes — user is watching   |
//! | System-triggered op completions   | Never                    |

use log::{debug, error, info, trace, warn};
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use crate::utils::types::{logs::LogLevel, origin::Origin};

// ---------------------------------------------------------------------------
// Public event type
// ---------------------------------------------------------------------------

/// Every OS notification the application can emit.
///
/// Each variant is self-contained: it carries all the data needed to render
/// the notification text and determine whether to suppress the toast.
/// Add a new variant here to extend the system — suppression policy and
/// i18n keys are defined alongside the variant in the `impl` block below.
#[derive(Debug)]
pub enum NotificationEvent {
    // -- Job lifecycle -------------------------------------------------------
    /// A transfer/operation job completed successfully.
    JobCompleted {
        remote: String,
        profile: Option<String>,
        operation: String,
        /// Where the job was initiated. Drives suppression: UI-initiated
        /// completions are suppressed while the app is focused.
        origin: Origin,
    },

    /// A transfer/operation job started.
    JobStarted {
        remote: String,
        profile: Option<String>,
        operation: String,
        origin: Origin,
    },

    /// A job ended with an error.
    /// Always shown — errors are never suppressed regardless of origin.
    JobFailed {
        remote: String,
        profile: Option<String>,
        operation: String,
        error: String,
        /// Kept for auditing / log context, does not affect suppression.
        origin: Origin,
    },

    /// The user manually stopped a running job.
    JobStopped {
        remote: String,
        profile: Option<String>,
        operation: String,
        origin: Origin,
    },

    // -- Serve lifecycle -----------------------------------------------------
    /// A serve instance started successfully.
    ServeStarted {
        remote: String,
        profile: Option<String>,
        addr: String,
        origin: Origin,
    },

    /// A serve operation failed to start. Always shown.
    ServeFailed {
        remote: String,
        profile: Option<String>,
        error: String,
        origin: Origin,
    },

    /// A serve instance stopped successfully.
    ServeStopped {
        remote: String,
        profile: Option<String>,
        origin: Origin,
    },

    /// `stop_all_serves` was called but there were no active serves.
    NothingToDoServes,

    /// `stop_all_serves` completed and there were active serves.
    AllServesStopped,

    /// `stop_all_serves` failed.
    StopAllServesFailed {
        error: String,
    },

    // -- Mount lifecycle -----------------------------------------------------
    MountSucceeded {
        remote: String,
        profile: Option<String>,
        mount_point: String,
        origin: Origin,
    },

    /// Mount failed. Always shown — the user needs to know.
    MountFailed {
        mount_point: String,
        error: String,
    },

    UnmountSucceeded {
        remote: String,
        /// Empty string if no named profile was used.
        profile: String,
        origin: Origin,
    },

    /// `unmount_all` completed and there were mounted remotes.
    AllUnmounted,

    /// `unmount_all` was called but nothing was mounted.
    NothingToUnmount,

    /// `stop_all_jobs` was called but there were no active jobs.
    NothingToDoJobs,

    /// `stop_all_jobs` completed and many jobs were stopped.
    AllJobsStopped {
        count: String,
    },

    // -- Engine / connectivity issues ----------------------------------------
    // These are always critical: never suppress.
    /// The remote requires a password that has not been supplied.
    EnginePasswordRequired {
        remote: String,
    },

    /// The rclone binary was not found on the system.
    EngineBinaryNotFound,

    /// The rclone daemon could not be reached or failed to start.
    EngineConnectionFailed {
        reason: String,
    },
    /// The engine was restarted due to a configuration change.
    EngineRestarted {
        reason: String,
    },

    /// Engine restart failed.
    EngineRestartFailed {
        reason: String,
    },

    // -- Update alerts -------------------------------------------------------
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
    /// Another instance attempted to run while this one is active.
    AlreadyRunning,

    // -- Scheduled tasks (always background-triggered) -----------------------
    ScheduledTaskCompleted {
        task_name: String,
    },
    ScheduledTaskFailed {
        task_name: String,
        error: String,
    },
}

// ---------------------------------------------------------------------------
// Suppression policy (internal)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Suppression {
    /// Always deliver the OS toast.
    Never,
    /// Omit the OS toast while the main window is focused.
    /// The user is already watching — a popup would be noise.
    WhenFocused,
}

impl NotificationEvent {
    fn suppression(&self) -> Suppression {
        match self {
            // Critical — never silent.
            Self::EnginePasswordRequired { .. }
            | Self::EngineBinaryNotFound
            | Self::EngineConnectionFailed { .. } => Suppression::Never,

            // Failures are always surfaced regardless of who triggered the job.
            Self::JobFailed { .. }
            | Self::MountFailed { .. }
            | Self::ServeFailed { .. }
            | Self::StopAllServesFailed { .. }
            | Self::EngineRestarted { .. }
            | Self::EngineRestartFailed { .. } => Suppression::Never,

            // Updates: always surface; the in-app indicator may be easy to miss.
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

            // Scheduled tasks are purely background events — the user had no
            // visual indication the task was running, so always show the result.
            Self::ScheduledTaskCompleted { .. } | Self::ScheduledTaskFailed { .. } => {
                Suppression::Never
            }

            // User-initiated ops: if the user clicked something and stayed in
            // the app, they can see the result. If they walked away, show the
            // toast. Scheduler/System origins bypass the suppression entirely.
            Self::JobCompleted { origin, .. }
            | Self::JobStarted { origin, .. }
            | Self::JobStopped { origin, .. }
            | Self::MountSucceeded { origin, .. }
            | Self::UnmountSucceeded { origin, .. }
            | Self::ServeStarted { origin, .. }
            | Self::ServeStopped { origin, .. } => {
                if origin.is_user_facing() {
                    Suppression::WhenFocused
                } else {
                    Suppression::Never
                }
            }

            // Bulk-unmount / stop-serves feedback: suppress only when focused
            // (the user just clicked the button and can see the result in the UI).
            Self::AllUnmounted
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
    /// Translate the event into display strings and determine the log level.
    fn render(&self) -> RenderedContent {
        use crate::utils::i18n::{t, t_with_params};

        match self {
            Self::JobCompleted {
                remote,
                profile,
                operation,
                ..
            } => RenderedContent {
                title: t_with_params(
                    "notification.title.operationComplete",
                    &[("operation", operation)],
                ),
                body: t_with_params(
                    "notification.body.complete",
                    &[
                        ("operation", operation),
                        ("remote", remote),
                        ("profile", profile.as_deref().unwrap_or("")),
                    ],
                ),
                level: LogLevel::Info,
            },

            Self::JobStarted {
                remote,
                profile,
                operation,
                ..
            } => RenderedContent {
                title: t_with_params(
                    "notification.title.operationStarted",
                    &[("operation", operation)],
                ),
                body: t_with_params(
                    "notification.body.started",
                    &[
                        ("operation", operation),
                        ("remote", remote),
                        ("profile", profile.as_deref().unwrap_or("")),
                    ],
                ),
                level: LogLevel::Info,
            },

            Self::JobFailed {
                remote,
                profile,
                operation,
                error,
                ..
            } => RenderedContent {
                title: t_with_params(
                    "notification.title.operationFailed",
                    &[("operation", operation), ("error", error)],
                ),
                body: t_with_params(
                    "notification.body.failed",
                    &[
                        ("operation", operation),
                        ("remote", remote),
                        ("profile", profile.as_deref().unwrap_or("")),
                        ("error", error),
                    ],
                ),
                level: LogLevel::Error,
            },

            Self::JobStopped {
                remote,
                profile,
                operation,
                ..
            } => RenderedContent {
                title: t_with_params(
                    "notification.title.operationStopped",
                    &[("operation", operation)],
                ),
                body: t_with_params(
                    "notification.body.stopped",
                    &[
                        ("operation", operation),
                        ("remote", remote),
                        ("profile", profile.as_deref().unwrap_or("")),
                    ],
                ),
                level: LogLevel::Info,
            },

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

            Self::StopAllServesFailed { error } => RenderedContent {
                title: t("notification.title.stopAllServesFailed"),
                body: t_with_params("notification.body.stopAllServesFailed", &[("error", error)]),
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
/// Translates the event, emits a structured log entry, checks suppression,
/// and delivers the OS toast if appropriate. This is the only notification
/// function call sites should use — the old `send_notification_typed` is gone.
pub fn notify(app: &tauri::AppHandle, event: NotificationEvent) {
    let enabled: bool = app
        .try_state::<crate::core::settings::AppSettingsManager>()
        .and_then(|m| m.inner().get("general.notifications").ok())
        .unwrap_or(false);

    let is_focused = window_is_focused(app);
    let suppressed = event.suppression() == Suppression::WhenFocused && is_focused;

    let RenderedContent { title, body, level } = event.render();

    // Always emit a log regardless of OS notification state.
    emit_log(level, &title, &body);

    debug!("🔔 suppressed={suppressed} focused={is_focused} — {title}",);

    if !enabled {
        debug!("🔕 notifications disabled in settings");
        return;
    }

    if suppressed {
        debug!("🔕 suppressed: app is focused and operation was user-initiated");
        return;
    }

    if let Err(e) = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .auto_cancel()
        .show()
    {
        error!("failed to show OS notification: {e}");
    }
}

/// Public test/helper: decide whether a completion notification originating
/// from `origin` would be suppressed when the app is focused.
///
/// This mirrors the suppression logic used by `notify` but exposes a
/// small, easy-to-test function for other modules and unit tests.
pub fn should_suppress(is_focused: bool, origin: Option<&Origin>) -> bool {
    let origin_val = origin.cloned().unwrap_or(Origin::System);
    let event = NotificationEvent::JobCompleted {
        remote: String::new(),
        profile: None,
        operation: String::new(),
        origin: origin_val,
    };
    event.suppression() == Suppression::WhenFocused && is_focused
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

#[cfg(not(target_os = "windows"))]
fn window_is_focused(app: &tauri::AppHandle) -> bool {
    app.webview_windows()
        .values()
        .any(|w| w.is_focused().unwrap_or(false))
}

#[cfg(target_os = "windows")]
fn window_is_focused(_app: &tauri::AppHandle) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return false;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        pid == std::process::id()
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
        let cases = [
            NotificationEvent::EnginePasswordRequired {
                remote: "gdrive:".into(),
            },
            NotificationEvent::EngineBinaryNotFound,
            NotificationEvent::EngineConnectionFailed {
                reason: "timeout".into(),
            },
        ];
        for event in cases {
            assert_eq!(event.suppression(), Suppression::Never, "{event:?}");
        }
    }

    #[test]
    fn failures_are_never_suppressed_regardless_of_origin() {
        // Even a UI-initiated job failure must always surface.
        let e = NotificationEvent::JobFailed {
            remote: "s3:".into(),
            profile: None,
            operation: "sync".into(),
            error: "permission denied".into(),
            origin: Origin::Ui,
        };
        assert_eq!(e.suppression(), Suppression::Never);

        let e = NotificationEvent::MountFailed {
            mount_point: "/mnt/r".into(),
            error: "fuse not available".into(),
        };
        assert_eq!(e.suppression(), Suppression::Never);
    }

    #[test]
    fn ui_initiated_completion_suppressed_when_focused() {
        let e = NotificationEvent::JobCompleted {
            remote: "gdrive:".into(),
            profile: Some("backup".into()),
            operation: "sync".into(),
            origin: Origin::Ui,
        };
        assert_eq!(e.suppression(), Suppression::WhenFocused);
    }

    #[test]
    fn scheduler_completion_always_shown() {
        let e = NotificationEvent::JobCompleted {
            remote: "gdrive:".into(),
            profile: None,
            operation: "sync".into(),
            origin: Origin::Scheduler,
        };
        assert_eq!(e.suppression(), Suppression::Never);
    }

    #[test]
    fn system_completion_always_shown() {
        let e = NotificationEvent::MountSucceeded {
            remote: "gdrive:".into(),
            profile: None,
            mount_point: "/mnt/g".into(),
            origin: Origin::System,
        };
        assert_eq!(e.suppression(), Suppression::Never);
    }

    #[test]
    fn all_user_facing_origins_suppress_completions() {
        let make_completion = |origin| NotificationEvent::MountSucceeded {
            remote: "r:".into(),
            profile: None,
            mount_point: "/mnt/r".into(),
            origin,
        };
        assert_eq!(
            make_completion(Origin::Ui).suppression(),
            Suppression::WhenFocused
        );
        assert_eq!(
            make_completion(Origin::Dashboard).suppression(),
            Suppression::WhenFocused
        );
        assert_eq!(
            make_completion(Origin::FileManager).suppression(),
            Suppression::WhenFocused
        );
        assert_eq!(
            make_completion(Origin::Scheduler).suppression(),
            Suppression::Never
        );
        assert_eq!(
            make_completion(Origin::System).suppression(),
            Suppression::Never
        );
    }

    #[test]
    fn scheduled_task_events_always_shown() {
        assert_eq!(
            NotificationEvent::ScheduledTaskCompleted {
                task_name: "nightly-backup".into()
            }
            .suppression(),
            Suppression::Never,
        );
        assert_eq!(
            NotificationEvent::ScheduledTaskFailed {
                task_name: "nightly-backup".into(),
                error: "disk full".into(),
            }
            .suppression(),
            Suppression::Never,
        );
    }

    #[test]
    fn updates_always_shown() {
        assert_eq!(
            NotificationEvent::AppUpdateAvailable {
                version: "2.0.0".into()
            }
            .suppression(),
            Suppression::Never,
        );
        assert_eq!(
            NotificationEvent::RcloneUpdateAvailable {
                version: "1.67".into()
            }
            .suppression(),
            Suppression::Never,
        );
    }
}
