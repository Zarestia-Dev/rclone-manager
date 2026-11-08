//! Workflow DAG execution engine.
//!
//! Orchestrates the server-side execution of visual workflows: dependency-driven
//! node scheduling, concurrent branches, live progress events, cancellation and
//! data flow between nodes.
//!
//! - [`run`] schedules one workflow run and reports its progress.
//! - [`graph`] holds the per-run node and edge state and the edge rules.
//! - [`nodes`] executes a single node; each kind has its own handler.
//! - [`active`] tracks running workflows and stops them.
//! - [`triggers`] starts workflows when a job finishes.
//! - [`cancel`] is the cancellation token every wait respects.

pub(crate) mod active;
pub(crate) mod cancel;
pub(crate) mod graph;
pub(crate) mod nodes;
pub(crate) mod run;
pub(crate) mod triggers;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use parking_lot::RwLock;
use serde_json::Value;

use crate::context::AppHandle;
use crate::rclone::backend::types::Backend;
use crate::services::flow::workflow::engine::cancel::CancelToken;
use crate::services::flow::workflow::types::{NodeKind, WorkflowNode};
use crate::utils::types::starter::WorkflowRun;

pub use active::{get_active_workflow_ids, has_active_workflows, stop_workflow};
pub use run::execute_workflow;
pub(crate) use run::execute_workflow_snapshot;
pub use triggers::{job_event_matches_job, trigger_workflows_for_job_finish};

/// Everything a node needs from its run. Cloning is cheap: handles and one `Arc`.
pub(crate) struct RunContext {
    pub(crate) app: AppHandle,
    pub(crate) backend: Backend,
    pub(crate) snapshot: Arc<crate::services::automation::runtime::WorkflowSnapshot>,
    pub(crate) cancel: CancelToken,
    pub(crate) active_jobs: Arc<RwLock<HashSet<u64>>>,
    pub(crate) node_results: Arc<RwLock<HashMap<String, Value>>>,
    /// Identifies this execution, unlike the workflow id shared by every run.
    pub(crate) run_id: String,
    pub(crate) dry_run: bool,
    /// The workflows whose jobs led to this run; what the work it starts is marked with.
    pub(crate) ancestors: Vec<String>,
}

impl RunContext {
    /// What the work `node` starts is marked with.
    pub(crate) fn workflow_run(&self, node: &WorkflowNode) -> WorkflowRun {
        WorkflowRun::new(
            self.snapshot.definition.id.clone(),
            self.snapshot.definition.name.clone(),
            node.id.clone(),
            self.ancestors.clone(),
        )
    }
}

/// What started a run. Only the triggers of that kind begin it; a workflow with
/// several triggers does not run every branch whenever one of them fires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunTrigger {
    /// Started by hand.
    Manual,
    /// A cron schedule fired.
    Cron,
    /// A watched path changed.
    Watcher,
    /// The application started.
    AppStart,
    /// A job finished. `node_ids` are the `job_event` nodes that matched it and
    /// `ancestors` the workflows whose jobs led to this run.
    JobEvent {
        node_ids: HashSet<String>,
        ancestors: Vec<String>,
    },
}

impl RunTrigger {
    /// The workflows whose jobs led to a run started this way.
    pub(crate) fn ancestors(&self) -> &[String] {
        match self {
            Self::JobEvent { ancestors, .. } => ancestors,
            _ => &[],
        }
    }

    fn node_kind(&self) -> NodeKind {
        match self {
            Self::Manual => NodeKind::Manual,
            Self::Cron => NodeKind::Cron,
            Self::Watcher => NodeKind::Watcher,
            Self::AppStart => NodeKind::AppStart,
            Self::JobEvent { .. } => NodeKind::JobEvent,
        }
    }

    /// Whether `node` is a trigger this run was started by.
    pub(crate) fn starts(&self, node: &WorkflowNode) -> bool {
        match self {
            Self::JobEvent { node_ids, .. } => node_ids.contains(&node.id),
            other => node.kind() == other.node_kind(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_job_event_run_has_workflows_before_it() {
        let job_event = RunTrigger::JobEvent {
            node_ids: HashSet::new(),
            ancestors: vec!["a".into()],
        };
        assert_eq!(job_event.ancestors(), ["a"]);
        assert!(RunTrigger::Cron.ancestors().is_empty());
    }
}
