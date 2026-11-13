use crate::utils::types::starter::Starter;
use serde::{Deserialize, Serialize};

/// Where an operation was initiated from or the functional domain it belongs to.
///
/// Stored on [`JobInfo`] for auditing; the alert system uses it to categorize
/// history and decide whether completion toasts should be suppressed.
///
/// `Workflow` and `QuickRun` also tag automations, alert rules and workflow events. Work
/// (a job, mount or serve) never stores them: its [`Starter`] says so, see [`Origin::of_work`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    /// Action initiated from the main application Dashboard.
    Dashboard,
    /// Automation task.
    Automation,
    /// Integration with OS shell (Nautilus, Finder, etc.).
    FileManager,
    /// Initial application boot and environment setup.
    Startup,
    /// Software update lifecycle (App or Rclone).
    Update,
    /// Background system processes (disk usage, directory sorting, cleanup).
    #[default]
    Internal,
    /// Workflow node run. Stored as `flow` before it was renamed, so that still reads.
    #[serde(alias = "flow")]
    Workflow,
    /// Quick Run preset execution.
    QuickRun,
}

impl std::fmt::Display for Origin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl Origin {
    /// The origin of work: the workflow node or Quick Run that started it wins over where
    /// it was requested from (`stored`), and work with neither falls back to `stored`.
    #[must_use]
    pub fn of_work(stored: Option<&Origin>, starter: Option<&Starter>) -> Origin {
        match starter {
            Some(
                Starter::Workflow(_)
                | Starter::QuickRun {
                    workflow: Some(_), ..
                },
            ) => Origin::Workflow,
            Some(Starter::QuickRun { workflow: None, .. }) => Origin::QuickRun,
            Some(Starter::Profile { .. }) | None => stored.cloned().unwrap_or_default(),
        }
    }

    /// Return a stable tag suitable for storage/IPC matching.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Origin::Dashboard => "dashboard",
            Origin::Automation => "automation",
            Origin::FileManager => "filemanager",
            Origin::Startup => "startup",
            Origin::Update => "update",
            Origin::Internal => "internal",
            Origin::Workflow => "workflow",
            Origin::QuickRun => "quickrun",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::types::starter::WorkflowRun;

    #[test]
    fn the_starter_decides_the_origin_of_work_before_the_stored_one() {
        let run = WorkflowRun::new("wf", "Workflow", "n1", vec![]);
        let stored = Some(&Origin::Dashboard);

        let node = Starter::Workflow(run.clone());
        assert_eq!(Origin::of_work(stored, Some(&node)), Origin::Workflow);
        // A node that ran a Quick Run is still workflow work.
        let node_quick_run = Starter::quick_run("qr", "Backup", Some(run));
        assert_eq!(
            Origin::of_work(stored, Some(&node_quick_run)),
            Origin::Workflow
        );
        let quick_run = Starter::quick_run("qr", "Backup", None);
        assert_eq!(Origin::of_work(stored, Some(&quick_run)), Origin::QuickRun);
    }

    #[test]
    fn a_workflow_origin_is_written_as_workflow_and_still_reads_as_flow() {
        assert_eq!(serde_json::to_value(Origin::Workflow).unwrap(), "workflow");
        assert_eq!(Origin::Workflow.as_str(), "workflow");
        for stored in ["workflow", "flow"] {
            let read: Origin = serde_json::from_value(serde_json::json!(stored)).unwrap();
            assert_eq!(read, Origin::Workflow);
        }
    }

    #[test]
    fn work_without_a_workflow_or_quick_run_keeps_its_stored_origin() {
        let profile = Starter::profile("Daily");
        assert_eq!(
            Origin::of_work(Some(&Origin::FileManager), Some(&profile)),
            Origin::FileManager
        );
        assert_eq!(
            Origin::of_work(Some(&Origin::Automation), None),
            Origin::Automation
        );
        assert_eq!(Origin::of_work(None, None), Origin::Internal);
    }
}
