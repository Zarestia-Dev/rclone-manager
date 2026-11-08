use serde::{Deserialize, Serialize};

/// What started a job, mount or serve: a profile, a Quick Run or a workflow node, never two
/// of them. A workflow node can run a Quick Run, which is the only case that names both.
///
/// Work that comes from none of them (a file manager action, an update) carries no starter.
/// Travels to the frontend as `{ "kind": "profile", "name": … }`,
/// `{ "kind": "quick_run", "id": …, "name": …, "workflow": … }` (`workflow` only when a node
/// started it) or `{ "kind": "workflow", "workflowId": …, "nodeId": …, "ancestors": […] }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Starter {
    Profile {
        name: String,
    },
    QuickRun {
        id: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workflow: Option<WorkflowRun>,
    },
    Workflow(WorkflowRun),
}

/// The workflow node that started a job, mount or serve.
///
/// A node cannot exist without its workflow, so the two travel as one. The workflow's name is
/// the one it had when the work started, as with a Quick Run's.
/// Travels to the frontend as
/// `{ "workflowId": …, "workflowName": …, "nodeId": …, "ancestors": […] }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub workflow_id: String,
    pub workflow_name: String,
    pub node_id: String,
    /// The workflows whose jobs led to `workflow_id` running, the latest last; not
    /// `workflow_id` itself. A workflow does not react to work it led to (see [`Self::lineage`]),
    /// so workflows cannot start each other forever.
    pub ancestors: Vec<String>,
}

impl WorkflowRun {
    #[must_use]
    pub fn new(
        workflow_id: impl Into<String>,
        workflow_name: impl Into<String>,
        node_id: impl Into<String>,
        ancestors: Vec<String>,
    ) -> Self {
        Self {
            workflow_id: workflow_id.into(),
            workflow_name: workflow_name.into(),
            node_id: node_id.into(),
            ancestors,
        }
    }

    /// Every workflow this work leads back to: the ancestors, then the workflow itself.
    #[must_use]
    pub fn lineage(&self) -> Vec<String> {
        let mut lineage = self.ancestors.clone();
        lineage.push(self.workflow_id.clone());
        lineage
    }

    /// Whether this is the given node of the given workflow.
    #[must_use]
    pub fn is_node(&self, workflow_id: &str, node_id: &str) -> bool {
        self.workflow_id == workflow_id && self.node_id == node_id
    }
}

impl Starter {
    #[must_use]
    pub fn profile(name: impl Into<String>) -> Self {
        Self::Profile { name: name.into() }
    }

    /// A Quick Run, started by `workflow` when a workflow node ran it.
    #[must_use]
    pub fn quick_run(
        id: impl Into<String>,
        name: impl Into<String>,
        workflow: Option<WorkflowRun>,
    ) -> Self {
        Self::QuickRun {
            id: id.into(),
            name: name.into(),
            workflow,
        }
    }

    /// The profile's name; `None` for a Quick Run.
    #[must_use]
    pub fn profile_name(&self) -> Option<&str> {
        match self {
            Self::Profile { name } => Some(name),
            Self::QuickRun { .. } | Self::Workflow(_) => None,
        }
    }

    /// The Quick Run's id; `None` for a profile or a workflow node's own operation.
    #[must_use]
    pub fn quick_run_id(&self) -> Option<&str> {
        match self {
            Self::QuickRun { id, .. } => Some(id),
            Self::Profile { .. } | Self::Workflow(_) => None,
        }
    }

    /// The workflow node that started the work, directly or by running a Quick Run.
    #[must_use]
    pub fn workflow_run(&self) -> Option<&WorkflowRun> {
        match self {
            Self::Workflow(run) => Some(run),
            Self::QuickRun { workflow, .. } => workflow.as_ref(),
            Self::Profile { .. } => None,
        }
    }
}

/// The profile name of an optional starter.
#[must_use]
pub fn profile_name(starter: Option<&Starter>) -> Option<&str> {
    starter.and_then(Starter::profile_name)
}

/// The Quick Run id of an optional starter.
#[must_use]
pub fn quick_run_id(starter: Option<&Starter>) -> Option<&str> {
    starter.and_then(Starter::quick_run_id)
}

/// The workflow node of an optional starter.
#[must_use]
pub fn workflow_run(starter: Option<&Starter>) -> Option<&WorkflowRun> {
    starter.and_then(Starter::workflow_run)
}

/// The id of the workflow that started the work.
#[must_use]
pub fn workflow_id(starter: Option<&Starter>) -> Option<&str> {
    workflow_run(starter).map(|run| run.workflow_id.as_str())
}

/// Whether the work was started by the given node of the given workflow.
#[must_use]
pub fn is_workflow_node(starter: Option<&Starter>, workflow_id: &str, node_id: &str) -> bool {
    workflow_run(starter).is_some_and(|run| run.is_node(workflow_id, node_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_profile_has_no_quick_run_and_a_quick_run_has_no_profile() {
        let profile = Starter::profile("Daily");
        assert_eq!(profile.profile_name(), Some("Daily"));
        assert_eq!(profile.quick_run_id(), None);

        let quick_run = Starter::quick_run("qr-1", "Backup", None);
        assert_eq!(quick_run.profile_name(), None);
        assert_eq!(quick_run.quick_run_id(), Some("qr-1"));

        // The same through an optional starter, which work nothing started carries.
        assert_eq!(profile_name(Some(&profile)), Some("Daily"));
        assert_eq!(quick_run_id(Some(&quick_run)), Some("qr-1"));
        assert_eq!(profile_name(None), None);
        assert_eq!(quick_run_id(None), None);
    }

    #[test]
    fn a_workflow_node_is_found_directly_or_through_the_quick_run_it_ran() {
        let run = WorkflowRun::new("wf-b", "Workflow", "n1", vec!["wf-a".into()]);
        let own = Starter::Workflow(run.clone());
        let quick_run = Starter::quick_run("qr-1", "Backup", Some(run.clone()));

        for starter in [&own, &quick_run] {
            assert_eq!(workflow_id(Some(starter)), Some("wf-b"));
            assert!(is_workflow_node(Some(starter), "wf-b", "n1"));
            assert!(!is_workflow_node(Some(starter), "wf-b", "n2"));
            assert!(!is_workflow_node(Some(starter), "wf-a", "n1"));
            assert_eq!(workflow_run(Some(starter)), Some(&run));
        }
        // Its own operation is neither a profile nor a Quick Run; the Quick Run keeps its id.
        assert_eq!(own.profile_name(), None);
        assert_eq!(own.quick_run_id(), None);
        assert_eq!(quick_run.quick_run_id(), Some("qr-1"));
        assert_eq!(quick_run.profile_name(), None);

        let standalone = Starter::quick_run("qr-1", "Backup", None);
        assert!(workflow_run(Some(&standalone)).is_none());
        assert!(workflow_run(Some(&Starter::profile("p"))).is_none());
        assert!(workflow_run(None).is_none());
        assert!(!is_workflow_node(None, "wf-b", "n1"));
    }

    #[test]
    fn the_wire_format_is_a_tagged_object() {
        assert_eq!(
            serde_json::to_value(Starter::profile("Daily")).unwrap(),
            json!({ "kind": "profile", "name": "Daily" })
        );
        assert_eq!(
            serde_json::to_value(Starter::quick_run("qr-1", "Backup", None)).unwrap(),
            json!({ "kind": "quick_run", "id": "qr-1", "name": "Backup" })
        );
    }

    #[test]
    fn the_workflow_variants_have_their_own_wire_format() {
        let run = WorkflowRun::new("wf-b", "Workflow", "n1", vec!["wf-a".into()]);
        let own = json!({
            "kind": "workflow",
            "workflowId": "wf-b",
            "workflowName": "Workflow",
            "nodeId": "n1",
            "ancestors": ["wf-a"],
        });
        assert_eq!(
            serde_json::to_value(Starter::Workflow(run.clone())).unwrap(),
            own
        );
        assert_eq!(
            serde_json::from_value::<Starter>(own).unwrap(),
            Starter::Workflow(run.clone())
        );

        let in_node = Starter::quick_run("qr-1", "Backup", Some(run));
        let json = serde_json::to_value(&in_node).unwrap();
        assert_eq!(json["kind"], "quick_run");
        assert_eq!(json["workflow"]["nodeId"], "n1");
        assert_eq!(serde_json::from_value::<Starter>(json).unwrap(), in_node);
    }

    #[test]
    fn unknown_kinds_and_missing_fields_do_not_parse() {
        assert!(serde_json::from_value::<Starter>(json!({ "kind": "profile" })).is_err());
        assert!(
            serde_json::from_value::<Starter>(json!({ "kind": "other", "name": "x" })).is_err()
        );
        assert!(serde_json::from_value::<Starter>(json!({ "name": "x" })).is_err());
        // A Quick Run without its id is not one.
        assert!(
            serde_json::from_value::<Starter>(json!({ "kind": "quick_run", "name": "x" })).is_err()
        );
    }

    #[test]
    fn work_nothing_started_leaves_the_field_out_and_started_work_carries_it() {
        use crate::utils::types::jobs::JobInfo;
        use crate::utils::types::remotes::{MountedRemote, ServeInstance};

        let starter = Starter::profile("Daily");
        let mut job = JobInfo::for_test();
        let mut mount = MountedRemote::new("drive:", "/mnt");
        let mut serve = ServeInstance::new("id", "127.0.0.1:1", json!({}));
        for value in [
            serde_json::to_value(&job).unwrap(),
            serde_json::to_value(&mount).unwrap(),
            serde_json::to_value(&serve).unwrap(),
        ] {
            assert!(value.get("starter").is_none());
        }

        job.starter = Some(starter.clone());
        mount.starter = Some(starter.clone());
        serve.starter = Some(starter);
        for value in [
            serde_json::to_value(&job).unwrap(),
            serde_json::to_value(&mount).unwrap(),
            serde_json::to_value(&serve).unwrap(),
        ] {
            assert_eq!(
                value["starter"],
                json!({ "kind": "profile", "name": "Daily" })
            );
        }
    }

    #[test]
    fn the_lineage_is_the_ancestors_followed_by_the_workflow_itself() {
        assert_eq!(
            WorkflowRun::new("b", "Workflow", "n", vec![]).lineage(),
            ["b"]
        );
        assert_eq!(
            WorkflowRun::new("c", "Workflow", "n", vec!["a".into(), "b".into()]).lineage(),
            ["a", "b", "c"]
        );
    }

    #[test]
    fn a_node_is_told_by_workflow_and_node_together() {
        let run = WorkflowRun::new("wf", "Workflow", "n1", vec![]);
        assert!(run.is_node("wf", "n1"));
        assert!(!run.is_node("wf", "n2"));
        assert!(!run.is_node("other", "n1"));
    }

    #[test]
    fn a_node_without_its_workflow_does_not_parse() {
        let parse = |value| serde_json::from_value::<Starter>(value);
        assert!(parse(json!({ "kind": "workflow", "nodeId": "n", "ancestors": [] })).is_err());
        assert!(parse(json!({ "kind": "workflow", "workflowId": "w", "ancestors": [] })).is_err());
    }
}
