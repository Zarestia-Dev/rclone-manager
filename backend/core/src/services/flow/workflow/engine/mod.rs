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

pub use active::{get_active_workflow_ids, has_active_workflows, stop_workflow};
pub(crate) use nodes::rc::parse_rc_params;
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
}
