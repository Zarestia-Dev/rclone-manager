use crate::core::alerts::types::{AlertEventKind, AlertSeverity};
use crate::utils::app::notification::{
    AutomationStage, EngineStage, JobStage, MountStage, NotificationEvent, ServeStage, UpdateStage,
};
use crate::utils::types::origin::Origin;

pub trait NotificationEventExt {
    fn alert_kind(&self) -> AlertEventKind;
    fn alert_severity(&self) -> AlertSeverity;
    fn alert_operation(&self) -> Option<String>;
    fn alert_origin(&self) -> Origin;
    fn alert_source(&self) -> Option<String>;
    fn alert_destination(&self) -> Option<String>;
}

#[derive(Clone, Debug)]
pub struct AlertMeta {
    pub remote: Option<String>,
    pub profile: Option<String>,
    pub backend: Option<String>,
}

impl NotificationEvent {
    pub fn alert_meta(&self) -> AlertMeta {
        match self {
            Self::Job(stage) => match stage {
                JobStage::Started {
                    remote,
                    profile,
                    backend,
                    ..
                }
                | JobStage::Completed {
                    remote,
                    profile,
                    backend,
                    ..
                }
                | JobStage::Failed {
                    remote,
                    profile,
                    backend,
                    ..
                }
                | JobStage::Stopped {
                    remote,
                    profile,
                    backend,
                    ..
                } => AlertMeta {
                    remote: Some(remote.clone()),
                    profile: profile.clone(),
                    backend: Some(backend.clone()),
                },
            },
            Self::Serve(
                ServeStage::Started {
                    remote,
                    profile,
                    backend,
                    ..
                }
                | ServeStage::Failed {
                    remote,
                    profile,
                    backend,
                    ..
                }
                | ServeStage::Stopped {
                    remote,
                    profile,
                    backend,
                    ..
                },
            ) => AlertMeta {
                remote: Some(remote.clone()),
                profile: profile.clone(),
                backend: Some(backend.clone()),
            },
            Self::Mount(
                MountStage::Succeeded {
                    remote,
                    profile,
                    backend,
                    ..
                }
                | MountStage::Failed {
                    remote,
                    profile,
                    backend,
                    ..
                }
                | MountStage::UnmountSucceeded {
                    remote,
                    profile,
                    backend,
                    ..
                },
            ) => AlertMeta {
                remote: Some(remote.clone()),
                profile: profile.clone(),
                backend: Some(backend.clone()),
            },
            Self::Automation(stage) => match stage {
                AutomationStage::Started {
                    remote,
                    profile,
                    backend,
                    ..
                }
                | AutomationStage::Completed {
                    remote,
                    profile,
                    backend,
                    ..
                }
                | AutomationStage::Failed {
                    remote,
                    profile,
                    backend,
                    ..
                } => AlertMeta {
                    remote: Some(remote.clone()),
                    profile: Some(profile.clone()),
                    backend: Some(backend.clone()),
                },
            },
            Self::Serve(ServeStage::AllStopped) => AlertMeta {
                remote: None,
                profile: None,
                backend: None,
            },
            Self::Mount(MountStage::AllUnmounted) => AlertMeta {
                remote: None,
                profile: None,
                backend: None,
            },
            Self::AppUpdate(_) | Self::RcloneUpdate(_) | Self::Engine(_) | Self::System(_) => {
                AlertMeta {
                    remote: None,
                    profile: None,
                    backend: None,
                }
            }
        }
    }
}

impl NotificationEventExt for NotificationEvent {
    fn alert_kind(&self) -> AlertEventKind {
        match self {
            Self::Job(_) => AlertEventKind::Job,
            Self::Serve(_) => AlertEventKind::Serve,
            Self::Mount(_) => AlertEventKind::Mount,
            Self::Engine(_) => AlertEventKind::Engine,
            Self::AppUpdate(_) | Self::RcloneUpdate(_) => AlertEventKind::Update,
            Self::Automation(_) => AlertEventKind::Automation,
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
            Self::Automation(stage) => match stage {
                AutomationStage::Failed { .. } => AlertSeverity::High,
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

    fn alert_operation(&self) -> Option<String> {
        match self {
            Self::Job(stage) => match stage {
                JobStage::Started { job_type, .. }
                | JobStage::Completed { job_type, .. }
                | JobStage::Failed { job_type, .. }
                | JobStage::Stopped { job_type, .. } => Some(job_type.to_string()),
            },
            Self::Automation(stage) => match stage {
                AutomationStage::Started {
                    automation_type, ..
                }
                | AutomationStage::Completed {
                    automation_type, ..
                }
                | AutomationStage::Failed {
                    automation_type, ..
                } => Some(automation_type.to_string()),
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
            Self::Automation(_) => Origin::Automation,
            Self::AppUpdate(_) | Self::RcloneUpdate(_) => Origin::Update,
            Self::Engine(_) => Origin::Internal,
            Self::System(_) => Origin::Internal,
            Self::Serve(_) | Self::Mount(_) => Origin::Dashboard,
        }
    }

    fn alert_source(&self) -> Option<String> {
        match self {
            Self::Job(stage) => match stage {
                JobStage::Started { source, .. }
                | JobStage::Completed { source, .. }
                | JobStage::Failed { source, .. }
                | JobStage::Stopped { source, .. } => source.clone(),
            },
            _ => None,
        }
    }

    fn alert_destination(&self) -> Option<String> {
        match self {
            Self::Job(stage) => match stage {
                JobStage::Started { destination, .. }
                | JobStage::Completed { destination, .. }
                | JobStage::Failed { destination, .. }
                | JobStage::Stopped { destination, .. } => destination.clone(),
            },
            _ => None,
        }
    }
}
