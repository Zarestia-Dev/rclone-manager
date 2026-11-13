//! Settles a conflict bisync found: keeps one version of the file on both paths.
//!
//! After a run, bisync leaves the version of each path under `path1Now` and `path2Now`, and has
//! copied both to the other path. Keeping a version means that version becomes the file on both
//! paths and the other version's copies go. The steps run one after another and the first failure
//! ends them, so a failed copy never leads to a delete.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::context::AppHandle;
use crate::rclone::commands::job::{JobMetadata, SubmitJobOptions, submit_job_with_options};
use crate::rclone::endpoints::operations;
use crate::utils::types::jobs::JobType;
use crate::utils::types::origin::Origin;

/// A file that changed on both paths, as read from the log of a bisync run: its name, and the
/// names bisync gave each path's version.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BisyncConflict {
    pub path: String,
    pub path1_now: String,
    pub path2_now: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Path1,
    Path2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Step {
    /// Moves a file to another name on one path, replacing what is there.
    Rename {
        side: Side,
        from: String,
        to: String,
    },
    /// Copies a file from one path to the other, replacing what is there.
    Copy {
        from: Side,
        path: String,
    },
    Delete {
        side: Side,
        path: String,
    },
}

/// The steps that keep the version of `keep`. `exists` tells what each path holds right now.
fn plan(
    conflict: &BisyncConflict,
    keep: Side,
    exists: impl Fn(Side, &str) -> bool,
) -> Result<Vec<Step>, String> {
    let target = conflict.path.as_str();
    let kept = match keep {
        Side::Path1 => &conflict.path1_now,
        Side::Path2 => &conflict.path2_now,
    };
    if !exists(keep, kept) {
        return Err(crate::localized_error!(
            "backendErrors.bisyncConflict.versionGone",
            "path" => kept.as_str()
        ));
    }

    let mut steps = vec![
        Step::Rename {
            side: keep,
            from: kept.clone(),
            to: target.to_string(),
        },
        Step::Copy {
            from: keep,
            path: target.to_string(),
        },
    ];

    let mut names = Vec::new();
    for name in [&conflict.path1_now, &conflict.path2_now] {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    for side in [Side::Path1, Side::Path2] {
        for name in &names {
            // The kept version was renamed away above and no longer exists under this name.
            if (side == keep && *name == kept) || !exists(side, name) {
                continue;
            }
            steps.push(Step::Delete {
                side,
                path: (*name).clone(),
            });
        }
    }
    Ok(steps)
}

fn fs_of<'a>(path1: &'a str, path2: &'a str, side: Side) -> &'a str {
    match side {
        Side::Path1 => path1,
        Side::Path2 => path2,
    }
}

async fn run(
    app: &AppHandle,
    endpoint: &str,
    mut payload: Value,
    metadata: JobMetadata,
) -> Result<Value, String> {
    if let Some(object) = payload.as_object_mut() {
        object.insert("_async".to_string(), json!(true));
    }
    let submission = submit_job_with_options(
        app.clone(),
        endpoint,
        payload,
        metadata,
        SubmitJobOptions {
            wait_for_completion: true,
            backend: None,
        },
    )
    .await?;
    Ok(submission.output.unwrap_or_else(|| json!({})))
}

/// Keeps the version of `keep` of the conflict on both paths. `path1` and `path2` are the paths
/// the bisync job ran on.
pub async fn resolve_bisync_conflict(
    app: AppHandle,
    path1: String,
    path2: String,
    conflict: BisyncConflict,
    keep: Side,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    // What each path holds now, read before anything changes.
    let mut present: HashSet<(Side, String)> = HashSet::new();
    for side in [Side::Path1, Side::Path2] {
        let fs = fs_of(&path1, &path2, side);
        for name in [&conflict.path1_now, &conflict.path2_now] {
            let stat = run(
                &app,
                operations::STAT,
                json!({"fs": fs, "remote": name, "opt": {"filesOnly": true}}),
                JobMetadata::for_query(
                    fs,
                    format!("{fs}{name}"),
                    JobType::Stat,
                    origin.clone(),
                    group.clone(),
                ),
            )
            .await?;
            if stat.get("item").is_some_and(|item| !item.is_null()) {
                present.insert((side, name.clone()));
            }
        }
    }

    let steps = plan(&conflict, keep, |side, name| {
        present.contains(&(side, name.to_string()))
    })?;

    for step in steps {
        let (endpoint, payload, job_type, fs, file) = match &step {
            Step::Rename { side, from, to } => {
                let fs = fs_of(&path1, &path2, *side);
                (
                    operations::MOVEFILE,
                    json!({"srcFs": fs, "srcRemote": from, "dstFs": fs, "dstRemote": to}),
                    JobType::Rename,
                    fs,
                    from,
                )
            }
            Step::Copy { from, path } => {
                let src = fs_of(&path1, &path2, *from);
                let dst = match from {
                    Side::Path1 => &path2,
                    Side::Path2 => &path1,
                };
                (
                    operations::COPYFILE,
                    json!({"srcFs": src, "srcRemote": path, "dstFs": dst, "dstRemote": path}),
                    JobType::Copy,
                    src,
                    path,
                )
            }
            Step::Delete { side, path } => {
                let fs = fs_of(&path1, &path2, *side);
                (
                    operations::DELETEFILE,
                    json!({"fs": fs, "remote": path}),
                    JobType::Delete,
                    fs,
                    path,
                )
            }
        };
        let metadata = JobMetadata::for_mutation(
            fs,
            vec![format!("{fs}{file}")],
            "",
            job_type,
            origin.clone(),
            group.clone(),
        );
        run(&app, endpoint, payload, metadata)
            .await
            .map_err(|error| {
                crate::localized_error!(
                    "backendErrors.bisyncConflict.stepFailed",
                    "path" => file.as_str(),
                    "error" => error
                )
            })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conflict(now1: &str, now2: &str) -> BisyncConflict {
        BisyncConflict {
            path: "a.txt".into(),
            path1_now: now1.into(),
            path2_now: now2.into(),
        }
    }

    /// Both versions exist on both paths, which is what bisync leaves behind.
    fn both_paths(names: &'static [&'static str]) -> impl Fn(Side, &str) -> bool {
        move |_, name| names.contains(&name)
    }

    fn rename(side: Side, from: &str, to: &str) -> Step {
        Step::Rename {
            side,
            from: from.into(),
            to: to.into(),
        }
    }
    fn delete(side: Side, path: &str) -> Step {
        Step::Delete {
            side,
            path: path.into(),
        }
    }

    #[test]
    fn the_kept_version_takes_the_original_name_and_every_copy_of_the_rest_goes() {
        let c = conflict("a.txt.conflict1", "a.txt.conflict2");
        let exists = both_paths(&["a.txt.conflict1", "a.txt.conflict2"]);
        assert_eq!(
            plan(&c, Side::Path1, &exists).unwrap(),
            vec![
                rename(Side::Path1, "a.txt.conflict1", "a.txt"),
                Step::Copy {
                    from: Side::Path1,
                    path: "a.txt".into()
                },
                delete(Side::Path1, "a.txt.conflict2"),
                delete(Side::Path2, "a.txt.conflict1"),
                delete(Side::Path2, "a.txt.conflict2"),
            ]
        );
        assert_eq!(
            plan(&c, Side::Path2, &exists).unwrap(),
            vec![
                rename(Side::Path2, "a.txt.conflict2", "a.txt"),
                Step::Copy {
                    from: Side::Path2,
                    path: "a.txt".into()
                },
                delete(Side::Path1, "a.txt.conflict1"),
                delete(Side::Path1, "a.txt.conflict2"),
                delete(Side::Path2, "a.txt.conflict1"),
            ]
        );
    }

    #[test]
    fn only_copies_that_exist_are_deleted() {
        let c = conflict("a.txt.conflict1", "a.txt.conflict2");
        let only_own_side = |side: Side, name: &str| match side {
            Side::Path1 => name == "a.txt.conflict1",
            Side::Path2 => name == "a.txt.conflict2",
        };
        assert_eq!(
            plan(&c, Side::Path1, only_own_side).unwrap(),
            vec![
                rename(Side::Path1, "a.txt.conflict1", "a.txt"),
                Step::Copy {
                    from: Side::Path1,
                    path: "a.txt".into()
                },
                delete(Side::Path2, "a.txt.conflict2"),
            ]
        );
    }

    #[test]
    fn a_version_that_is_gone_cannot_be_kept() {
        let c = conflict("a.txt.conflict1", "a.txt.conflict2");
        let error = plan(&c, Side::Path1, both_paths(&["a.txt.conflict2"])).unwrap_err();
        assert!(error.contains("backendErrors.bisyncConflict.versionGone"));
        assert!(error.contains("a.txt.conflict1"));
        assert!(plan(&c, Side::Path2, both_paths(&["a.txt.conflict2"])).is_ok());
    }

    #[test]
    fn a_conflict_reads_the_way_the_report_names_its_fields() {
        let parsed: BisyncConflict = serde_json::from_value(json!({
            "path": "a", "path1Now": "a.conflict1", "path2Now": "a.conflict2",
        }))
        .unwrap();
        assert_eq!(parsed.path, "a");
        assert_eq!(parsed.path1_now, "a.conflict1");
        assert_eq!(parsed.path2_now, "a.conflict2");
        assert_eq!(
            serde_json::from_value::<Side>(json!("path2")).unwrap(),
            Side::Path2
        );
        assert!(serde_json::from_value::<Side>(json!("Path2")).is_err());
    }
}
