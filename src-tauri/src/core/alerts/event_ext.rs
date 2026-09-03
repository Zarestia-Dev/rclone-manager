use crate::core::alerts::types::{AlertEventKind, AlertSeverity};
use crate::utils::app::notification::{
    AutomationStage, EngineStage, JobStage, MountStage, NotificationEvent, ServeStage, UpdateStage,
    WorkflowStage,
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

impl WorkflowStage {
    pub fn workflow_name(&self) -> &str {
        match self {
            Self::Started { workflow_name, .. }
            | Self::Completed { workflow_name, .. }
            | Self::Failed { workflow_name, .. }
            | Self::Stopped { workflow_name, .. } => workflow_name,
        }
    }

    pub fn workflow_id(&self) -> &str {
        match self {
            Self::Started { workflow_id, .. }
            | Self::Completed { workflow_id, .. }
            | Self::Failed { workflow_id, .. }
            | Self::Stopped { workflow_id, .. } => workflow_id,
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
            Self::Workflow(stage) => {
                AlertMeta::new("Workflow", stage.workflow_name(), Some(stage.workflow_id()))
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
            Self::Workflow(_) => AlertEventKind::Workflow,
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
            Self::Workflow(stage) => match stage {
                WorkflowStage::Failed { .. } => AlertSeverity::High,
                WorkflowStage::Stopped { .. } => AlertSeverity::Warning,
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
            Self::Workflow(_) => Some("Workflow".to_string()),
            Self::Serve(stage) => stage.protocol().map(String::from),
            _ => None,
        }
    }

    #[must_use]
    pub fn alert_origin(&self) -> Origin {
        match self {
            Self::Job(stage) => stage.origin().clone(),
            Self::Automation(_) => Origin::Automation,
            Self::Workflow(stage) => stage.origin().clone(),
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

#[cfg(test)]
mod tests {
    use crate::core::alerts::types::{AlertEventKind, AlertSeverity};
    use crate::utils::app::notification::{NotificationEvent, WorkflowStage};
    use crate::utils::types::origin::Origin;

    #[test]
    fn test_workflow_started_event_conversion() {
        let event = NotificationEvent::Workflow(WorkflowStage::Started {
            workflow_id: "wf-123".to_string(),
            workflow_name: "Backup Daily".to_string(),
            origin: Origin::Flow,
        });

        assert_eq!(event.alert_kind(), AlertEventKind::Workflow);
        assert_eq!(event.alert_severity(), AlertSeverity::Info);
        assert_eq!(event.alert_origin(), Origin::Flow);
        assert_eq!(event.alert_operation(), Some("Workflow".to_string()));
    }

    #[test]
    fn test_workflow_failed_event_conversion() {
        let event = NotificationEvent::Workflow(WorkflowStage::Failed {
            workflow_id: "wf-456".to_string(),
            workflow_name: "Sync S3".to_string(),
            error: "Connection timeout".to_string(),
            failed_node_title: Some("Upload step".to_string()),
            origin: Origin::Flow,
        });

        assert_eq!(event.alert_kind(), AlertEventKind::Workflow);
        assert_eq!(event.alert_severity(), AlertSeverity::High);
        assert_eq!(event.alert_origin(), Origin::Flow);
    }

    #[test]
    fn test_workflow_stopped_and_completed() {
        let completed = NotificationEvent::Workflow(WorkflowStage::Completed {
            workflow_id: "wf-789".to_string(),
            workflow_name: "Archive".to_string(),
            duration_ms: 1500,
            origin: Origin::Flow,
        });
        assert_eq!(completed.alert_severity(), AlertSeverity::Info);

        let stopped = NotificationEvent::Workflow(WorkflowStage::Stopped {
            workflow_id: "wf-789".to_string(),
            workflow_name: "Archive".to_string(),
            origin: Origin::Flow,
        });
        assert_eq!(stopped.alert_severity(), AlertSeverity::Warning);
    }
}
