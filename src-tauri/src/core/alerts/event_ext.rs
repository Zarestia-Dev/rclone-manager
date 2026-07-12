use crate::core::alerts::types::{AlertEventKind, AlertSeverity};
use crate::utils::app::notification::{
    AutomationStage, EngineStage, JobStage, MountStage, NotificationEvent, ServeStage, UpdateStage,
};
use crate::utils::types::jobs::JobType;
use crate::utils::types::origin::Origin;
use crate::utils::types::remotes::OperationType;

#[derive(Clone, Debug)]
pub struct AlertMeta {
    pub remote: Option<String>,
    pub profile: Option<String>,
    pub backend: Option<String>,
}

impl AlertMeta {
    pub fn new(backend: &str, remote: &str, profile: Option<&str>) -> Self {
        Self {
            remote: Some(remote.to_string()),
            profile: profile.map(String::from),
            backend: Some(backend.to_string()),
        }
    }

    pub fn empty() -> Self {
        Self {
            remote: None,
            profile: None,
            backend: None,
        }
    }
}

impl JobStage {
    pub fn meta(&self) -> (&str, &str, Option<&str>) {
        match self {
            Self::Started {
                backend,
                remote,
                profile,
                ..
            }
            | Self::Completed {
                backend,
                remote,
                profile,
                ..
            }
            | Self::Failed {
                backend,
                remote,
                profile,
                ..
            }
            | Self::Stopped {
                backend,
                remote,
                profile,
                ..
            } => (backend, remote, profile.as_deref()),
        }
    }

    pub fn job_type(&self) -> &JobType {
        match self {
            Self::Started { job_type, .. }
            | Self::Completed { job_type, .. }
            | Self::Failed { job_type, .. }
            | Self::Stopped { job_type, .. } => job_type,
        }
    }

    pub fn origin(&self) -> &Origin {
        match self {
            Self::Started { origin, .. }
            | Self::Completed { origin, .. }
            | Self::Failed { origin, .. }
            | Self::Stopped { origin, .. } => origin,
        }
    }

    pub fn source(&self) -> Option<&str> {
        match self {
            Self::Started { source, .. }
            | Self::Completed { source, .. }
            | Self::Failed { source, .. }
            | Self::Stopped { source, .. } => source.as_deref(),
        }
    }

    pub fn destination(&self) -> Option<&str> {
        match self {
            Self::Started { destination, .. }
            | Self::Completed { destination, .. }
            | Self::Failed { destination, .. }
            | Self::Stopped { destination, .. } => destination.as_deref(),
        }
    }
}

impl ServeStage {
    pub fn meta(&self) -> Option<(&str, &str, Option<&str>)> {
        match self {
            Self::Started {
                backend,
                remote,
                profile,
                ..
            }
            | Self::Failed {
                backend,
                remote,
                profile,
                ..
            }
            | Self::Stopped {
                backend,
                remote,
                profile,
                ..
            } => Some((backend, remote, profile.as_deref())),
            Self::AllStopped => None,
        }
    }

    pub fn protocol(&self) -> Option<&str> {
        match self {
            Self::Started { protocol, .. }
            | Self::Failed { protocol, .. }
            | Self::Stopped { protocol, .. } => Some(protocol),
            Self::AllStopped => None,
        }
    }
}

impl MountStage {
    pub fn meta(&self) -> Option<(&str, &str, Option<&str>)> {
        match self {
            Self::Succeeded {
                backend,
                remote,
                profile,
                ..
            }
            | Self::Failed {
                backend,
                remote,
                profile,
                ..
            }
            | Self::UnmountSucceeded {
                backend,
                remote,
                profile,
                ..
            } => Some((backend, remote, profile.as_deref())),
            Self::AllUnmounted => None,
        }
    }
}

impl AutomationStage {
    pub fn meta(&self) -> (&str, &str, &str) {
        match self {
            Self::Started {
                backend,
                remote,
                profile,
                ..
            }
            | Self::Completed {
                backend,
                remote,
                profile,
                ..
            }
            | Self::Failed {
                backend,
                remote,
                profile,
                ..
            }
            | Self::Stopped {
                backend,
                remote,
                profile,
                ..
            } => (backend, remote, profile),
        }
    }

    pub fn automation_type(&self) -> &OperationType {
        match self {
            Self::Started {
                automation_type, ..
            }
            | Self::Completed {
                automation_type, ..
            }
            | Self::Failed {
                automation_type, ..
            }
            | Self::Stopped {
                automation_type, ..
            } => automation_type,
        }
    }
}

impl NotificationEvent {
    #[must_use]
    pub fn alert_meta(&self) -> AlertMeta {
        match self {
            Self::Job(stage) => {
                let (backend, remote, profile) = stage.meta();
                AlertMeta::new(backend, remote, profile)
            }
            Self::Serve(stage) => match stage.meta() {
                Some((backend, remote, profile)) => AlertMeta::new(backend, remote, profile),
                None => AlertMeta::empty(),
            },
            Self::Mount(stage) => match stage.meta() {
                Some((backend, remote, profile)) => AlertMeta::new(backend, remote, profile),
                None => AlertMeta::empty(),
            },
            Self::Automation(stage) => {
                let (backend, remote, profile) = stage.meta();
                AlertMeta::new(backend, remote, Some(profile))
            }
            Self::AppUpdate(_) | Self::RcloneUpdate(_) | Self::Engine(_) | Self::System(_) => {
                AlertMeta::empty()
            }
        }
    }

    #[must_use]
    pub fn alert_kind(&self) -> AlertEventKind {
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

    #[must_use]
    pub fn alert_severity(&self) -> AlertSeverity {
        match self {
            Self::Job(stage) => match stage {
                JobStage::Failed { .. } => AlertSeverity::High,
                JobStage::Stopped { .. } => AlertSeverity::Warning,
                _ => AlertSeverity::Info,
            },
            Self::Automation(stage) => match stage {
                AutomationStage::Failed { .. } => AlertSeverity::High,
                AutomationStage::Stopped { .. } => AlertSeverity::Warning,
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
                EngineStage::PasswordRequired
                | EngineStage::ConnectionFailed { .. }
                | EngineStage::AuthFailed { .. } => AlertSeverity::High,
                EngineStage::Restarted => AlertSeverity::Info,
            },
            Self::AppUpdate(stage) | Self::RcloneUpdate(stage) => match stage {
                UpdateStage::Failed { .. } => AlertSeverity::Warning,
                _ => AlertSeverity::Info,
            },
            Self::System(_) => AlertSeverity::Info,
        }
    }

    #[must_use]
    pub fn alert_operation(&self) -> Option<String> {
        match self {
            Self::Job(stage) => Some(stage.job_type().to_string()),
            Self::Automation(stage) => Some(stage.automation_type().to_string()),
            Self::Serve(stage) => stage.protocol().map(String::from),
            _ => None,
        }
    }

    #[must_use]
    pub fn alert_origin(&self) -> Origin {
        match self {
            Self::Job(stage) => stage.origin().clone(),
            Self::Automation(_) => Origin::Automation,
            Self::AppUpdate(_) | Self::RcloneUpdate(_) => Origin::Update,
            Self::Engine(_) => Origin::Internal,
            Self::System(_) => Origin::Internal,
            Self::Serve(_) | Self::Mount(_) => Origin::Dashboard,
        }
    }

    #[must_use]
    pub fn alert_source(&self) -> Option<String> {
        match self {
            Self::Job(stage) => stage.source().map(String::from),
            _ => None,
        }
    }

    #[must_use]
    pub fn alert_destination(&self) -> Option<String> {
        match self {
            Self::Job(stage) => stage.destination().map(String::from),
            _ => None,
        }
    }
}
