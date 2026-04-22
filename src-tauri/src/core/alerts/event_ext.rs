use crate::core::alerts::types::{AlertEventKind, AlertSeverity};
use crate::utils::app::notification::NotificationEvent;
use crate::utils::types::origin::Origin;

pub trait NotificationEventExt {
    fn alert_severity(&self) -> AlertSeverity;
    fn alert_kind(&self) -> AlertEventKind;
    fn alert_remote(&self) -> Option<String>;
    fn alert_operation(&self) -> Option<String>;
    fn alert_origin(&self) -> Option<Origin>;
}

impl NotificationEventExt for NotificationEvent {
    fn alert_severity(&self) -> AlertSeverity {
        match self {
            Self::EngineBinaryNotFound
            | Self::EnginePasswordRequired { .. }
            | Self::EngineConnectionFailed { .. } => AlertSeverity::Critical,

            Self::JobFailed { .. }
            | Self::MountFailed { .. }
            | Self::ServeFailed { .. }
            | Self::EngineRestartFailed { .. }
            | Self::AppUpdateFailed { .. }
            | Self::RcloneUpdateFailed { .. }
            | Self::ScheduledTaskFailed { .. } => AlertSeverity::High,

            Self::EngineRestarted { .. }
            | Self::RcloneUpdateComplete { .. }
            | Self::AppUpdateComplete { .. } => AlertSeverity::Average,

            Self::JobCompleted { .. }
            | Self::JobStarted { .. }
            | Self::JobStopped { .. }
            | Self::ServeStopped { .. }
            | Self::NothingToDoServes
            | Self::NothingToUnmount
            | Self::NothingToDoJobs
            | Self::AlreadyRunning
            | Self::MountSucceeded { .. }
            | Self::ServeStarted { .. }
            | Self::UnmountSucceeded { .. }
            | Self::AllUnmounted
            | Self::AllServesStopped
            | Self::AllJobsStopped { .. }
            | Self::ScheduledTaskStarted { .. }
            | Self::ScheduledTaskCompleted { .. }
            | Self::AppUpdateInstalled { .. }
            | Self::RcloneUpdateInstalled { .. } => AlertSeverity::Info,

            Self::AppUpdateAvailable { .. }
            | Self::AppUpdateStarted { .. }
            | Self::RcloneUpdateAvailable { .. }
            | Self::RcloneUpdateStarted { .. } => AlertSeverity::Warning,
        }
    }

    fn alert_kind(&self) -> AlertEventKind {
        match self {
            Self::JobCompleted { .. } => AlertEventKind::JobCompleted,
            Self::JobStarted { .. } => AlertEventKind::JobStarted,
            Self::JobFailed { .. } => AlertEventKind::JobFailed,
            Self::JobStopped { .. } => AlertEventKind::JobStopped,
            Self::ServeStarted { .. } => AlertEventKind::ServeStarted,
            Self::ServeFailed { .. } => AlertEventKind::ServeFailed,
            Self::ServeStopped { .. } => AlertEventKind::ServeStopped,
            Self::AllServesStopped => AlertEventKind::AllServesStopped,
            Self::NothingToDoServes => AlertEventKind::Any,
            Self::MountSucceeded { .. } => AlertEventKind::MountSucceeded,
            Self::MountFailed { .. } => AlertEventKind::MountFailed,
            Self::UnmountSucceeded { .. } => AlertEventKind::UnmountSucceeded,
            Self::AllUnmounted => AlertEventKind::AllUnmounted,
            Self::NothingToUnmount => AlertEventKind::Any,
            Self::NothingToDoJobs => AlertEventKind::Any,
            Self::AllJobsStopped { .. } => AlertEventKind::AllJobsStopped,
            Self::EnginePasswordRequired { .. } => AlertEventKind::EnginePasswordRequired,
            Self::EngineBinaryNotFound => AlertEventKind::EngineBinaryNotFound,
            Self::EngineConnectionFailed { .. } => AlertEventKind::EngineConnectionFailed,
            Self::EngineRestarted { .. } => AlertEventKind::EngineRestarted,
            Self::EngineRestartFailed { .. } => AlertEventKind::EngineRestartFailed,
            Self::AppUpdateAvailable { .. } => AlertEventKind::AppUpdateAvailable,
            Self::AppUpdateStarted { .. } => AlertEventKind::AppUpdateStarted,
            Self::AppUpdateComplete { .. } => AlertEventKind::AppUpdateComplete,
            Self::AppUpdateFailed { .. } => AlertEventKind::AppUpdateFailed,
            Self::AppUpdateInstalled { .. } => AlertEventKind::AppUpdateInstalled,
            Self::RcloneUpdateAvailable { .. } => AlertEventKind::RcloneUpdateAvailable,
            Self::RcloneUpdateStarted { .. } => AlertEventKind::RcloneUpdateStarted,
            Self::RcloneUpdateComplete { .. } => AlertEventKind::RcloneUpdateComplete,
            Self::RcloneUpdateFailed { .. } => AlertEventKind::RcloneUpdateFailed,
            Self::RcloneUpdateInstalled { .. } => AlertEventKind::RcloneUpdateInstalled,
            Self::AlreadyRunning => AlertEventKind::AlreadyRunning,
            Self::ScheduledTaskStarted { .. } => AlertEventKind::ScheduledTaskStarted,
            Self::ScheduledTaskCompleted { .. } => AlertEventKind::ScheduledTaskCompleted,
            Self::ScheduledTaskFailed { .. } => AlertEventKind::ScheduledTaskFailed,
        }
    }

    fn alert_remote(&self) -> Option<String> {
        match self {
            Self::JobCompleted { remote, .. }
            | Self::JobStarted { remote, .. }
            | Self::JobFailed { remote, .. }
            | Self::JobStopped { remote, .. }
            | Self::ServeStarted { remote, .. }
            | Self::ServeFailed { remote, .. }
            | Self::ServeStopped { remote, .. }
            | Self::MountSucceeded { remote, .. }
            | Self::UnmountSucceeded { remote, .. }
            | Self::EnginePasswordRequired { remote } => Some(remote.clone()),

            Self::MountFailed { mount_point, .. } => Some(mount_point.clone()),

            _ => None,
        }
    }

    fn alert_operation(&self) -> Option<String> {
        match self {
            Self::JobCompleted { job_type, .. }
            | Self::JobStarted { job_type, .. }
            | Self::JobFailed { job_type, .. }
            | Self::JobStopped { job_type, .. } => Some(job_type.to_string()),

            _ => None,
        }
    }

    fn alert_origin(&self) -> Option<Origin> {
        match self {
            Self::JobCompleted { origin, .. }
            | Self::JobStarted { origin, .. }
            | Self::JobFailed { origin, .. }
            | Self::JobStopped { origin, .. }
            | Self::ServeStarted { origin, .. }
            | Self::ServeStopped { origin, .. }
            | Self::MountSucceeded { origin, .. }
            | Self::UnmountSucceeded { origin, .. }
            | Self::ServeFailed { origin, .. } => Some(origin.clone()),

            Self::AppUpdateAvailable { .. }
            | Self::AppUpdateStarted { .. }
            | Self::AppUpdateComplete { .. }
            | Self::AppUpdateFailed { .. }
            | Self::AppUpdateInstalled { .. }
            | Self::RcloneUpdateAvailable { .. }
            | Self::RcloneUpdateStarted { .. }
            | Self::RcloneUpdateComplete { .. }
            | Self::RcloneUpdateFailed { .. }
            | Self::RcloneUpdateInstalled { .. } => Some(Origin::Update),

            Self::EngineBinaryNotFound
            | Self::EnginePasswordRequired { .. }
            | Self::EngineConnectionFailed { .. }
            | Self::EngineRestarted { .. }
            | Self::EngineRestartFailed { .. } => Some(Origin::Startup),

            Self::ScheduledTaskStarted { .. }
            | Self::ScheduledTaskCompleted { .. }
            | Self::ScheduledTaskFailed { .. } => Some(Origin::Scheduler),

            _ => Some(Origin::Internal),
        }
    }
}
