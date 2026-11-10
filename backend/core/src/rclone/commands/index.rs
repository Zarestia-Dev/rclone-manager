//! `operations/index`: the directory listings written into the folders of a remote.

use log::debug;
use serde_json::{Map, Value, json};

use crate::context::AppHandle;
use crate::rclone::commands::common::RclonePayloadBuilder;
use crate::rclone::commands::job::JobMetadata;
use crate::rclone::endpoints::operations;
use crate::utils::json_helpers::build_full_path;
use crate::utils::types::jobs::JobType;
use crate::utils::types::origin::Origin;

/// Where an automation run hands over the folders that changed, by full path. It is turned into
/// `opt.changed` (see [`move_index_options`]) and never reaches rclone under this name.
pub(crate) const CHANGED_DIRS: &str = "changedDirs";

/// Moves the index options, which a profile and the directory-listing dialog keep flat under
/// rclone's own names, to where `operations/index` reads them: the options in `opt`, the
/// directory rules in `opt.rules`. `_config` (where the payload builder puts `UseServerModTime`
/// and every other PascalCase option) stays. Nothing is renamed or checked: rclone judges the
/// values and says what is wrong.
///
/// The folders in [`CHANGED_DIRS`] that lie below `root` become `opt.changed`, which makes
/// rclone list only what they affect instead of the whole tree. Without any, it is a full run.
pub(crate) fn move_index_options(body: &mut Map<String, Value>, root: &str) {
    let mut opt = Map::new();
    let changed_dirs: Vec<String> = body
        .remove(CHANGED_DIRS)
        .and_then(|dirs| serde_json::from_value(dirs).ok())
        .unwrap_or_default();
    let changed = changes_below(root, &changed_dirs);
    if !changed.is_empty() {
        opt.insert("changed".to_string(), json!(changed));
    }
    for key in [
        "output",
        "maxDepth",
        "linkIndex",
        "dirTime",
        "noModTime",
        "rewrite",
    ] {
        if let Some(value) = body.remove(key) {
            opt.insert(key.to_string(), value);
        }
    }
    let mut config = match body.remove("_config") {
        Some(Value::Object(config)) => config,
        _ => Map::new(),
    };
    let mut rules = Map::new();
    for rule in ["IncludeRule", "ExcludeRule"] {
        if let Some(patterns) = config.remove(rule) {
            rules.insert(rule.to_string(), patterns);
        }
    }
    if !rules.is_empty() {
        opt.insert("rules".to_string(), Value::Object(rules));
    }
    body.insert("opt".to_string(), Value::Object(opt));
    if !config.is_empty() {
        body.insert("_config".to_string(), Value::Object(config));
    }
}

/// The folders of `changed` (full paths) that lie below `root`, as rclone's `opt.changed` takes
/// them: relative to the root, with a trailing `/` for a folder. The root itself is `/`, which
/// rclone answers with a full run.
fn changes_below(root: &str, changed: &[String]) -> Vec<String> {
    let root = root.trim_end_matches('/');
    changed
        .iter()
        .filter_map(|dir| {
            let relative = dir.strip_prefix(root)?;
            (relative.is_empty() || relative.starts_with('/'))
                .then(|| format!("{}/", relative.trim_matches('/')))
        })
        .collect()
}

/// Narrows a profile's index run, started by a folder watcher, to what changed: only the sources
/// that hold a change are listed, and each gets the changed folders in [`CHANGED_DIRS`]. `scoped`
/// is what the watcher computed, (changed folder, destination) pairs; an index has no destination.
/// Nothing is narrowed when no source holds a change, which leaves a full run.
pub(crate) fn narrow_to_changes(
    sources: &mut Vec<String>,
    rclone_config: &mut Value,
    scoped: Vec<(String, String)>,
) {
    let changed: Vec<String> = scoped.into_iter().map(|(dir, _)| dir).collect();
    let holding: Vec<String> = sources
        .iter()
        .filter(|source| !changes_below(source, &changed).is_empty())
        .cloned()
        .collect();
    if holding.is_empty() {
        return;
    }
    if let Some(config) = rclone_config.as_object_mut() {
        config.insert(CHANGED_DIRS.to_string(), json!(changed));
        *sources = holding;
    }
}

/// The `operations/index` request for `path` of `remote`, from the options as the directory
/// listing dialog keeps them. They go through the same builder as a profile's options.
fn index_payload(remote: &str, path: &str, options: &Value) -> Value {
    let fs = build_full_path(remote, path);
    let mut builder = RclonePayloadBuilder::from_rclone_config(options);
    builder.insert("fs", json!(fs));
    builder.insert("_async", json!(true));
    move_index_options(builder.as_map_mut(), &fs);
    builder.build()
}

pub async fn generate_index(
    app: AppHandle,
    remote: String,
    path: String,
    options: Value,
    origin: Option<Origin>,
    group: Option<String>,
) -> Result<(), String> {
    debug!("generate_index: remote={remote} path={path}");

    let payload = index_payload(&remote, &path, &options);
    let metadata = JobMetadata::for_mutation(remote, vec![path], "", JobType::Index, origin, group);
    crate::rclone::commands::job::submit_job_with_options(
        app,
        operations::INDEX,
        payload,
        metadata,
        crate::rclone::commands::job::SubmitJobOptions {
            wait_for_completion: true,
            ..Default::default()
        },
    )
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{CHANGED_DIRS, index_payload, narrow_to_changes};
    use crate::rclone::commands::sync::GenericTransferParams;
    use crate::rclone::endpoints::operations;
    use crate::utils::types::remotes::OperationType;
    use serde_json::{Value, json};

    fn index_params(rclone_config: Value) -> GenericTransferParams {
        GenericTransferParams {
            source: "s3:bucket/site".to_string(),
            dest: String::new(),
            rclone_config,
            filter_options: None,
            backend_options: None,
            runtime_remote_options: None,
            transfer_type: OperationType::Index,
            is_dir: true,
            dry_run: None,
        }
    }

    #[test]
    fn index_profile_options_move_into_opt_and_the_call_config() {
        let body = index_params(json!({
            "srcFs": "s3:bucket/site",
            "output": ["index.html=html", "index.json=json"],
            "maxDepth": 2,
            "linkIndex": true,
            "dirTime": "dir",
            "noModTime": true,
            "rewrite": true,
            "IncludeRule": ["/docs/**"],
            "ExcludeRule": ["/docs/private/**"],
            "UseServerModTime": true,
        }))
        .to_rclone_body(false)
        .unwrap();

        assert_eq!(body["_path"], operations::INDEX);
        assert_eq!(body["fs"], "s3:bucket/site");
        assert_eq!(
            body["opt"],
            json!({
                "output": ["index.html=html", "index.json=json"],
                "maxDepth": 2,
                "linkIndex": true,
                "dirTime": "dir",
                "noModTime": true,
                "rewrite": true,
                "rules": {"IncludeRule": ["/docs/**"], "ExcludeRule": ["/docs/private/**"]},
            })
        );
        assert_eq!(body["_config"]["UseServerModTime"], true);
        for moved in ["output", "maxDepth", "IncludeRule", "ExcludeRule"] {
            assert!(body.get(moved).is_none(), "{moved} stayed in the body");
        }
        assert_eq!(body["_config"], json!({ "UseServerModTime": true }));
    }

    #[test]
    fn index_without_options_leaves_every_default_to_rclone() {
        let body = index_params(json!({})).to_rclone_body(false).unwrap();
        assert_eq!(body["opt"], json!({}));
        assert!(body.get("_config").is_none());
    }

    #[test]
    fn index_values_reach_rclone_as_they_are_so_it_can_say_what_is_wrong() {
        let body = index_params(json!({
            "output": [],
            "maxDepth": 0,
            "dirTime": "",
            "IncludeRule": [],
            "UseServerModTime": false,
        }))
        .to_rclone_body(false)
        .unwrap();

        assert_eq!(
            body["opt"],
            json!({ "output": [], "maxDepth": 0, "dirTime": "", "rules": { "IncludeRule": [] } })
        );
        assert_eq!(body["_config"]["UseServerModTime"], false);
    }

    #[test]
    fn index_keeps_a_config_the_profile_already_carries() {
        let body = index_params(json!({"UseServerModTime": true, "_config": {"Transfers": 2}}))
            .to_rclone_body(false)
            .unwrap();
        assert_eq!(body["_config"]["UseServerModTime"], true);
        assert_eq!(body["_config"]["Transfers"], 2);
    }

    #[test]
    fn index_payload_targets_the_folder_and_runs_as_a_job() {
        let options =
            json!({ "output": ["index.html=html"], "maxDepth": 3, "UseServerModTime": true });
        let payload = index_payload("s3:", "bucket/site", &options);
        assert_eq!(payload["fs"], "s3:bucket/site");
        assert_eq!(
            payload["opt"],
            json!({ "output": ["index.html=html"], "maxDepth": 3 })
        );
        assert_eq!(payload["_async"], true);
        assert_eq!(payload["_config"], json!({ "UseServerModTime": true }));
        assert!(payload.get("UseServerModTime").is_none());
    }

    #[test]
    fn index_payload_without_options_keeps_every_default() {
        let payload = index_payload("s3:", "", &json!({}));
        assert_eq!(payload["fs"], "s3:");
        assert_eq!(payload["opt"], json!({}));
        assert!(payload.get("_config").is_none());
        assert_eq!(
            index_payload("s3:", "/", &serde_json::Value::Null)["fs"],
            "s3:"
        );
    }

    fn partial_body(source: &str, changed: Value) -> Value {
        let mut params = index_params(json!({ CHANGED_DIRS: changed }));
        params.source = source.to_string();
        params.to_rclone_body(false).unwrap()
    }

    #[test]
    fn changed_folders_become_a_partial_run_relative_to_the_source() {
        let body = partial_body(
            "/home/me/site",
            json!(["/home/me/site/a/b", "/home/me/site/c", "/elsewhere/x"]),
        );

        assert_eq!(body["opt"]["changed"], json!(["a/b/", "c/"]));
        assert!(
            body.get(CHANGED_DIRS).is_none(),
            "{CHANGED_DIRS} reached rclone"
        );
    }

    #[test]
    fn a_change_in_the_source_itself_is_the_root_that_rclone_answers_with_a_full_run() {
        let body = partial_body("/home/me/site/", json!(["/home/me/site"]));

        assert_eq!(body["opt"]["changed"], json!(["/"]));
    }

    #[test]
    fn a_folder_that_only_shares_the_name_prefix_is_not_below_the_source() {
        let body = partial_body("/home/me/site", json!(["/home/me/site-old/a"]));

        assert!(body["opt"].get("changed").is_none());
    }

    #[test]
    fn without_changed_folders_the_run_is_a_full_one() {
        let body = index_params(json!({})).to_rclone_body(false).unwrap();

        assert!(body["opt"].get("changed").is_none());
    }

    #[test]
    fn a_watcher_run_lists_only_the_sources_that_hold_a_change() {
        let mut sources = vec!["/r1".to_string(), "/r2".to_string(), "/r1x".to_string()];
        let mut config = json!({ "output": ["index.html=html"] });

        narrow_to_changes(
            &mut sources,
            &mut config,
            vec![("/r2/a".to_string(), String::new())],
        );

        assert_eq!(sources, ["/r2"]);
        assert_eq!(config[CHANGED_DIRS], json!(["/r2/a"]));
        assert_eq!(config["output"], json!(["index.html=html"]));
    }

    #[test]
    fn a_watcher_run_with_no_change_below_any_source_stays_a_full_run() {
        let mut sources = vec!["/r1".to_string()];
        let mut config = json!({});

        narrow_to_changes(
            &mut sources,
            &mut config,
            vec![("/elsewhere".to_string(), String::new())],
        );

        assert_eq!(sources, ["/r1"]);
        assert!(config.get(CHANGED_DIRS).is_none());
    }
}
