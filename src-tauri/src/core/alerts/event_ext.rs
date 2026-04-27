use crate::core::alerts::types::{AlertEventKind, AlertSeverity};
use crate::utils::app::notification::{
    EngineStage, JobStage, MountStage, NotificationEvent, ServeStage, TaskStage, UpdateStage,
};
use crate::utils::types::origin::Origin;

pub trait NotificationEventExt {
    fn alert_kind(&self) -> AlertEventKind;
    fn alert_severity(&self) -> AlertSeverity;
    fn alert_remote(&self) -> Option<String>;
    fn alert_profile(&self) -> Option<String>;
    fn alert_backend(&self) -> Option<String>;
    fn alert_operation(&self) -> Option<String>;
    fn alert_origin(&self) -> Origin;
}

impl NotificationEventExt for NotificationEvent {
    fn alert_kind(&self) -> AlertEventKind {
        match self {
            Self::Job(_) => AlertEventKind::Job,
            Self::Serve(_) => AlertEventKind::Serve,
            Self::Mount(_) => AlertEventKind::Mount,
            Self::Engine(_) => AlertEventKind::Engine,
            Self::AppUpdate(_) | Self::RcloneUpdate(_) => AlertEventKind::Update,
            Self::ScheduledTask(_) => AlertEventKind::ScheduledTask,
            Self::System(_) => AlertEventKind::System,
        }
    }

    fn alert_severity(&self) -> AlertSeverity {
        match self {
            Self::Job(stage) => match stage {
                JobStage::Failed { .. } => AlertSeverity::High,
                JobStage::Stopped { .. } => AlertSeverity::Warning,
                _ => AlertSeverity::Info,
            },
            Self::ScheduledTask(stage) => match stage {
                TaskStage::Failed { .. } => AlertSeverity::High,
                _ => AlertSeverity::Info,
            },
            Self::Serve(stage) => match stage {
                ServeStage::Failed { .. } => AlertSeverity::High,
                ServeStage::Stopped { .. } | ServeStage::AllStopped => AlertSeverity::Warning,
                _ => AlertSeverity::Info,
            },
            Self::Mount(stage) => match stage {
                MountStage::Failed { .. } => AlertSeverity::High,
                _ => AlertSeverity::Info,
            },
            Self::Engine(stage) => match stage {
                EngineStage::BinaryNotFound | EngineStage::RestartFailed { .. } => {
                    AlertSeverity::Critical
                }
                EngineStage::PasswordRequired | EngineStage::ConnectionFailed { .. } => {
                    AlertSeverity::High
                }
                EngineStage::Restarted => AlertSeverity::Info,
            },
            Self::AppUpdate(stage) | Self::RcloneUpdate(stage) => match stage {
                UpdateStage::Failed { .. } => AlertSeverity::Warning,
                _ => AlertSeverity::Info,
            },
            Self::System(_) => AlertSeverity::Info,
        }
    }

    fn alert_remote(&self) -> Option<String> {
        match self {
            Self::Job(stage) => match stage {
                JobStage::Started { remote, .. }
                | JobStage::Completed { remote, .. }
                | JobStage::Failed { remote, .. }
                | JobStage::Stopped { remote, .. } => Some(remote.clone()),
            },
            Self::Serve(
                ServeStage::Started { remote, .. }
                | ServeStage::Failed { remote, .. }
                | ServeStage::Stopped { remote, .. },
            ) => Some(remote.clone()),
            Self::Mount(
                MountStage::Succeeded { remote, .. }
                | MountStage::Failed { remote, .. }
                | MountStage::UnmountSucceeded { remote, .. },
            ) => Some(remote.clone()),
            Self::ScheduledTask(stage) => match stage {
                TaskStage::Started { remote, .. }
                | TaskStage::Completed { remote, .. }
                | TaskStage::Failed { remote, .. } => Some(remote.clone()),
            },
            _ => None,
        }
    }

    fn alert_profile(&self) -> Option<String> {
        match self {
            Self::Job(stage) => match stage {
                JobStage::Started { profile, .. }
                | JobStage::Completed { profile, .. }
                | JobStage::Failed { profile, .. }
                | JobStage::Stopped { profile, .. } => profile.clone(),
            },
            Self::Serve(
                ServeStage::Started { profile, .. }
                | ServeStage::Failed { profile, .. }
                | ServeStage::Stopped { profile, .. },
            ) => profile.clone(),
            Self::Mount(
                MountStage::Succeeded { profile, .. }
                | MountStage::Failed { profile, .. }
                | MountStage::UnmountSucceeded { profile, .. },
            ) => profile.clone(),
            Self::ScheduledTask(stage) => match stage {
                TaskStage::Started { profile, .. }
                | TaskStage::Completed { profile, .. }
                | TaskStage::Failed { profile, .. } => Some(profile.clone()),
            },
            _ => None,
        }
    }

    fn alert_backend(&self) -> Option<String> {
        match self {
            Self::Job(stage) => match stage {
                JobStage::Started { backend, .. }
                | JobStage::Completed { backend, .. }
                | JobStage::Failed { backend, .. }
                | JobStage::Stopped { backend, .. } => Some(backend.clone()),
            },
            Self::Serve(
                ServeStage::Started { backend, .. }
                | ServeStage::Failed { backend, .. }
                | ServeStage::Stopped { backend, .. },
            ) => Some(backend.clone()),
            Self::Mount(
                MountStage::Succeeded { backend, .. }
                | MountStage::Failed { backend, .. }
                | MountStage::UnmountSucceeded { backend, .. },
            ) => Some(backend.clone()),
            Self::ScheduledTask(stage) => match stage {
                TaskStage::Started { backend, .. }
                | TaskStage::Completed { backend, .. }
                | TaskStage::Failed { backend, .. } => Some(backend.clone()),
            },
            _ => None,
        }
    }

    fn alert_operation(&self) -> Option<String> {
        match self {
            Self::Job(stage) => match stage {
                JobStage::Started { job_type, .. }
                | JobStage::Completed { job_type, .. }
                | JobStage::Failed { job_type, .. }
                | JobStage::Stopped { job_type, .. } => Some(job_type.to_string()),
            },
            Self::ScheduledTask(stage) => match stage {
                TaskStage::Started { task_type, .. }
                | TaskStage::Completed { task_type, .. }
                | TaskStage::Failed { task_type, .. } => Some(task_type.to_string()),
            },
            Self::Serve(
                ServeStage::Started { protocol, .. }
                | ServeStage::Failed { protocol, .. }
                | ServeStage::Stopped { protocol, .. },
            ) => Some(protocol.clone()),
            _ => None,
        }
    }

    fn alert_origin(&self) -> Origin {
        match self {
            Self::Job(stage) => match stage {
                JobStage::Started { origin, .. }
                | JobStage::Completed { origin, .. }
                | JobStage::Failed { origin, .. }
                | JobStage::Stopped { origin, .. } => origin.clone(),
            },
            Self::ScheduledTask(_) => Origin::Scheduler,
            Self::AppUpdate(_) | Self::RcloneUpdate(_) => Origin::Update,
            Self::Engine(_) => Origin::Internal,
            Self::System(_) => Origin::Internal,
            Self::Serve(_) | Self::Mount(_) => Origin::Dashboard,
        }
    }
}
