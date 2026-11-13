//! What one run has done so far.
//!
//! The run is the only source of its state. Every change goes through [`RunHandle`],
//! which records it and announces it in one step, so what a view is told live and what
//! it reads from a [`WorkflowRunSnapshot`] later never differ. A view that opens while a
//! run is under way (or after a reload) reads the snapshot and then follows the events;
//! `seq` tells it which events the snapshot already contains.

use std::collections::{HashMap, VecDeque};

use chrono::{SecondsFormat, Utc};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

use crate::services::flow::workflow::types::{
    WorkflowExecutionState, WorkflowExecutionStateEvent, WorkflowNodeExecutionState,
    WorkflowNodeStateEvent, WorkflowProgress,
};
use crate::utils::types::events::{WORKFLOW_EXECUTION_STATE_CHANGED, WORKFLOW_NODE_STATE_CHANGED};

/// Most events a run keeps for the log a late view shows; the oldest go first.
const MAX_RUN_EVENTS: usize = 1000;

/// An event of a run as it is kept in the history.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunEvent {
    Node(WorkflowNodeStateEvent),
    Execution(WorkflowExecutionStateEvent),
}

/// The latest word on one node of a run.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeSnapshot {
    pub state: WorkflowNodeExecutionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
}

/// A run as it stands: live, or the last one that ended.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunSnapshot {
    pub workflow_id: String,
    pub run_id: String,
    pub dry_run: bool,
    /// RFC 3339, millisecond precision.
    pub started_at: String,
    pub state: WorkflowExecutionState,
    /// The `seq` of the last event this snapshot contains.
    pub seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<WorkflowProgress>,
    /// The latest state of each node that has reported, by node id.
    pub nodes: HashMap<String, NodeSnapshot>,
    /// What the log of the run is made of, oldest first.
    pub events: Vec<RunEvent>,
}

struct RunRecord {
    state: WorkflowExecutionState,
    seq: u64,
    progress: Option<WorkflowProgress>,
    nodes: HashMap<String, NodeSnapshot>,
    events: VecDeque<RunEvent>,
}

/// One run of a workflow. Shared by the run, which reports through it, and the
/// registry, which answers snapshots from it.
pub(crate) struct RunHandle {
    workflow_id: String,
    run_id: String,
    dry_run: bool,
    started_at: String,
    record: Mutex<RunRecord>,
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl RunHandle {
    pub(crate) fn new(workflow_id: &str, run_id: &str, dry_run: bool) -> Self {
        Self {
            workflow_id: workflow_id.to_string(),
            run_id: run_id.to_string(),
            dry_run,
            started_at: now(),
            record: Mutex::new(RunRecord {
                state: WorkflowExecutionState::Started,
                seq: 0,
                progress: None,
                nodes: HashMap::new(),
                events: VecDeque::new(),
            }),
        }
    }

    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }

    pub(crate) fn workflow_id(&self) -> &str {
        &self.workflow_id
    }

    /// Whether the run has not ended.
    pub(crate) fn is_live(&self) -> bool {
        self.record.lock().state.is_live()
    }

    /// Records and announces a node's new state. `output` is kept as the node's latest
    /// output; the history keeps the event without it.
    pub(crate) fn node_state(
        &self,
        node_id: &str,
        state: WorkflowNodeExecutionState,
        error_message: Option<&str>,
        duration_ms: Option<u64>,
        output: Option<Value>,
    ) {
        let mut record = self.record.lock();
        record.seq += 1;
        let mut event = WorkflowNodeStateEvent {
            workflow_id: self.workflow_id.clone(),
            run_id: self.run_id.clone(),
            seq: record.seq,
            at: now(),
            node_id: node_id.to_string(),
            state,
            error_message: error_message.map(str::to_string),
            duration_ms,
            output: None,
        };
        // The history and the node's record take the event as it is, without the output.
        record.push_event(RunEvent::Node(event.clone()));
        let earlier_output = record.nodes.remove(node_id).and_then(|node| node.output);
        event.output = output;
        record.nodes.insert(
            node_id.to_string(),
            NodeSnapshot {
                state,
                error_message: event.error_message.clone(),
                duration_ms,
                output: event.output.clone().or(earlier_output),
            },
        );
        // Announced under the lock: events leave in the order of their `seq`.
        crate::services::bridge::emit(WORKFLOW_NODE_STATE_CHANGED, &event);
    }

    /// Ends a run that was cut short without reporting its end: the steps that were still
    /// running did not finish, so they fail, and the run fails with them. Otherwise a view
    /// would show a spinner on a step of a run that is over.
    pub(crate) fn abort(&self) {
        let unfinished: Vec<String> = self
            .record
            .lock()
            .nodes
            .iter()
            .filter(|(_, node)| node.state == WorkflowNodeExecutionState::Running)
            .map(|(id, _)| id.clone())
            .collect();
        let reason = crate::localized_error!("backendErrors.workflow.executionCancelled");
        for id in unfinished {
            self.node_state(
                &id,
                WorkflowNodeExecutionState::Failed,
                Some(&reason),
                None,
                None,
            );
        }
        self.execution(WorkflowExecutionState::Failed, None, Some(reason));
    }

    /// Records and announces the run's new state. Progress is kept as the latest;
    /// only an event that says something is kept in the history.
    pub(crate) fn execution(
        &self,
        state: WorkflowExecutionState,
        progress: Option<WorkflowProgress>,
        message: Option<String>,
    ) {
        let mut record = self.record.lock();
        record.seq += 1;
        record.state = state;
        if progress.is_some() {
            record.progress.clone_from(&progress);
        }
        let event = WorkflowExecutionStateEvent {
            workflow_id: self.workflow_id.clone(),
            run_id: self.run_id.clone(),
            seq: record.seq,
            at: now(),
            state,
            dry_run: self.dry_run,
            progress,
            message,
        };
        if event.message.is_some() {
            record.push_event(RunEvent::Execution(event.clone()));
        }
        crate::services::bridge::emit(WORKFLOW_EXECUTION_STATE_CHANGED, &event);
    }

    pub(crate) fn snapshot(&self) -> WorkflowRunSnapshot {
        let record = self.record.lock();
        WorkflowRunSnapshot {
            workflow_id: self.workflow_id.clone(),
            run_id: self.run_id.clone(),
            dry_run: self.dry_run,
            started_at: self.started_at.clone(),
            state: record.state,
            seq: record.seq,
            progress: record.progress.clone(),
            nodes: record.nodes.clone(),
            events: record.events.iter().cloned().collect(),
        }
    }
}

impl RunRecord {
    fn push_event(&mut self, event: RunEvent) {
        if self.events.len() == MAX_RUN_EVENTS {
            self.events.pop_front();
        }
        self.events.push_back(event);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn progress(completed: usize) -> WorkflowProgress {
        WorkflowProgress {
            total: 3,
            completed,
            current_step_title: "step".into(),
        }
    }

    #[test]
    fn a_new_run_is_live_and_has_seen_nothing() {
        let run = RunHandle::new("wf", "run-1", true);
        let snapshot = run.snapshot();
        assert!(run.is_live());
        assert_eq!(snapshot.run_id, "run-1");
        assert!(snapshot.dry_run);
        assert_eq!(snapshot.seq, 0);
        assert!(snapshot.nodes.is_empty() && snapshot.events.is_empty());
    }

    #[test]
    fn every_change_advances_seq_by_one() {
        let run = RunHandle::new("wf", "run-1", false);
        run.execution(WorkflowExecutionState::Started, None, Some("go".into()));
        run.node_state("a", WorkflowNodeExecutionState::Running, None, None, None);
        run.execution(WorkflowExecutionState::Running, Some(progress(0)), None);
        assert_eq!(run.snapshot().seq, 3);
    }

    #[test]
    fn a_node_keeps_its_latest_state_and_the_last_output_it_gave() {
        let run = RunHandle::new("wf", "run-1", false);
        run.node_state(
            "a",
            WorkflowNodeExecutionState::Success,
            None,
            Some(12),
            Some(json!({ "n": 1 })),
        );
        run.node_state("a", WorkflowNodeExecutionState::Running, None, None, None);
        let node = &run.snapshot().nodes["a"];
        assert_eq!(node.state, WorkflowNodeExecutionState::Running);
        assert_eq!(node.output, Some(json!({ "n": 1 })));
        assert_eq!(node.duration_ms, None);
    }

    #[test]
    fn the_history_keeps_node_events_without_their_output() {
        let run = RunHandle::new("wf", "run-1", false);
        run.node_state(
            "a",
            WorkflowNodeExecutionState::Success,
            None,
            Some(1),
            Some(json!({ "big": true })),
        );
        let snapshot = run.snapshot();
        let RunEvent::Node(event) = &snapshot.events[0] else {
            panic!("expected a node event");
        };
        assert!(event.output.is_none());
        assert_eq!(snapshot.nodes["a"].output, Some(json!({ "big": true })));
    }

    #[test]
    fn progress_only_events_update_progress_but_stay_out_of_the_history() {
        let run = RunHandle::new("wf", "run-1", false);
        run.execution(WorkflowExecutionState::Running, Some(progress(1)), None);
        let snapshot = run.snapshot();
        assert_eq!(snapshot.progress, Some(progress(1)));
        assert!(snapshot.events.is_empty());

        run.execution(WorkflowExecutionState::Running, None, None);
        assert_eq!(run.snapshot().progress, Some(progress(1)));
    }

    #[test]
    fn a_final_state_ends_the_run() {
        let run = RunHandle::new("wf", "run-1", false);
        run.execution(
            WorkflowExecutionState::Cancelled,
            None,
            Some("stopped".into()),
        );
        assert!(!run.is_live());
        assert_eq!(run.snapshot().state, WorkflowExecutionState::Cancelled);
    }

    #[test]
    fn an_aborted_run_fails_the_steps_that_were_still_running() {
        let run = RunHandle::new("wf", "run-1", false);
        run.node_state(
            "done",
            WorkflowNodeExecutionState::Success,
            None,
            Some(1),
            None,
        );
        run.node_state(
            "busy",
            WorkflowNodeExecutionState::Running,
            None,
            None,
            None,
        );
        run.abort();

        let snapshot = run.snapshot();
        assert_eq!(snapshot.state, WorkflowExecutionState::Failed);
        assert_eq!(
            snapshot.nodes["busy"].state,
            WorkflowNodeExecutionState::Failed
        );
        assert!(snapshot.nodes["busy"].error_message.is_some());
        assert_eq!(
            snapshot.nodes["done"].state,
            WorkflowNodeExecutionState::Success
        );
    }

    #[test]
    fn the_history_drops_its_oldest_events_past_the_limit() {
        let run = RunHandle::new("wf", "run-1", false);
        for i in 0..MAX_RUN_EVENTS + 5 {
            run.node_state(
                &format!("n{i}"),
                WorkflowNodeExecutionState::Success,
                None,
                None,
                None,
            );
        }
        let snapshot = run.snapshot();
        assert_eq!(snapshot.events.len(), MAX_RUN_EVENTS);
        let RunEvent::Node(first) = &snapshot.events[0] else {
            panic!("expected a node event");
        };
        assert_eq!(first.seq, 6);
        // Every node still has its latest state.
        assert_eq!(snapshot.nodes.len(), MAX_RUN_EVENTS + 5);
    }

    #[test]
    fn a_snapshot_serializes_with_camel_case_and_tagged_events() {
        let run = RunHandle::new("wf", "run-1", false);
        run.node_state("a", WorkflowNodeExecutionState::Running, None, None, None);
        let value = serde_json::to_value(run.snapshot()).unwrap();
        assert_eq!(value["runId"], "run-1");
        assert_eq!(value["state"], "started");
        assert_eq!(value["events"][0]["kind"], "node");
        assert_eq!(value["events"][0]["nodeId"], "a");
        assert_eq!(value["nodes"]["a"]["state"], "running");
    }
}
