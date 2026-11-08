//! The file reports rclone returns for a finished sync, copy or move job.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::utils::types::jobs::JobType;

/// Keeps the reports of a finished sync, copy or move job. Other jobs return other output, and
/// without a report parameter rclone returns an empty object, which is not worth keeping.
///
/// `had_errors` is whether the job failed or counted an error. A move deletes the source of a file
/// that is already identical on the destination, and rclone logs the result of that delete as an
/// error even when there is none: the file shows up as `! path` in `combined`, in `error`, and a
/// second time in `destAfter`. With no error to explain them, the `!` entries are dropped. The
/// duplicate in `destAfter` goes either way, as a listing never holds a path twice.
#[must_use]
pub fn job_report(job_type: &JobType, output: Option<&Value>, had_errors: bool) -> Option<Value> {
    if !matches!(job_type, JobType::Sync | JobType::Copy | JobType::Move) {
        return None;
    }
    let mut report = merge_batch_reports(output?)?;
    if matches!(job_type, JobType::Move) {
        if !had_errors {
            drop_move_error_entries(&mut report);
        }
        if let Some(Value::Array(files)) = report.get_mut("destAfter") {
            let mut seen = std::collections::HashSet::new();
            files.retain(|file| seen.insert(file.clone()));
        }
    }
    Some(report)
}

/// A job started through `job/batch` returns `{"results": [report, ...]}`, one report per input.
/// The lists of every input are joined into one report; other output is kept as it is.
fn merge_batch_reports(output: &Value) -> Option<Value> {
    let reports = output.as_object().filter(|reports| !reports.is_empty())?;
    let Some(Value::Array(results)) = reports.get("results") else {
        return Some(output.clone());
    };
    let mut merged = serde_json::Map::new();
    for (name, list) in results.iter().filter_map(Value::as_object).flatten() {
        if let Value::Array(files) = list {
            if let Some(Value::Array(all)) = merged.get_mut(name) {
                all.extend(files.iter().cloned());
            } else {
                merged.insert(name.clone(), list.clone());
            }
        }
    }
    (!merged.is_empty()).then_some(Value::Object(merged))
}

fn drop_move_error_entries(report: &mut Value) {
    if let Some(Value::Array(lines)) = report.get_mut("combined") {
        lines.retain(|line| !line.as_str().is_some_and(|line| line.starts_with("! ")));
    }
    if let Some(Value::Array(files)) = report.get_mut("error") {
        files.clear();
    }
}

/// The number of files in each list of a report.
#[must_use]
pub fn report_counts(report: &Value) -> BTreeMap<String, usize> {
    report
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, list)| Some((name.clone(), list.as_array()?.len())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_sync_copy_and_move_keep_a_non_empty_report() {
        let output = json!({"combined": ["+ a.txt"]});
        for job_type in [JobType::Sync, JobType::Copy, JobType::Move] {
            assert_eq!(
                job_report(&job_type, Some(&output), false),
                Some(output.clone())
            );
        }
        for job_type in [
            JobType::Check,
            JobType::Bisync,
            JobType::List,
            JobType::Mount,
        ] {
            assert_eq!(job_report(&job_type, Some(&output), false), None);
        }
    }

    #[test]
    fn a_batch_joins_the_reports_of_its_inputs() {
        let output = json!({"results": [
            {"combined": ["+ a.txt"], "differ": [], "destAfter": ["a.txt"]},
            {"status": 500, "error": "failed"},
            {"combined": ["* b.txt"], "differ": ["b.txt"], "destAfter": ["b.txt"]},
        ]});
        assert_eq!(
            job_report(&JobType::Sync, Some(&output), false),
            Some(json!({
                "combined": ["+ a.txt", "* b.txt"],
                "differ": ["b.txt"],
                "destAfter": ["a.txt", "b.txt"],
            }))
        );
        for empty in [json!({"results": []}), json!({"results": [{"error": "x"}]})] {
            assert_eq!(job_report(&JobType::Sync, Some(&empty), false), None);
        }
    }

    #[test]
    fn empty_or_unusable_output_is_not_a_report() {
        for output in [json!({}), json!([]), json!("done"), json!(null)] {
            assert_eq!(job_report(&JobType::Sync, Some(&output), false), None);
        }
        assert_eq!(job_report(&JobType::Sync, None, false), None);
    }

    #[test]
    fn a_report_keeps_whatever_rclone_returned() {
        let output = json!({"combined": ["+ ü.txt"], "other": 5, "match": []});
        assert_eq!(
            job_report(&JobType::Move, Some(&output), false),
            Some(output)
        );
    }

    #[test]
    fn a_clean_move_drops_the_error_entries_rclone_logs_for_files_it_did_not_need_to_copy() {
        // What rclone v1.76.0 returns for a move where same.txt was already on the destination.
        let output = json!({
            "combined": ["- c.txt", "+ sub/b.txt", "* a.txt", "= same.txt", "! same.txt"],
            "destAfter": ["c.txt", "sub/b.txt", "a.txt", "same.txt", "same.txt"],
            "error": ["same.txt"],
            "match": ["same.txt"],
        });
        let report = job_report(&JobType::Move, Some(&output), false).unwrap();
        assert_eq!(
            report["combined"],
            json!(["- c.txt", "+ sub/b.txt", "* a.txt", "= same.txt"])
        );
        assert_eq!(report["error"], json!([]));
        assert_eq!(report["match"], json!(["same.txt"]));
        assert_eq!(
            report["destAfter"],
            json!(["c.txt", "sub/b.txt", "a.txt", "same.txt"])
        );
    }

    #[test]
    fn a_move_with_errors_and_other_job_types_keep_every_entry() {
        let output = json!({"combined": ["+ a.txt", "! a.txt"], "error": ["a.txt"]});
        assert_eq!(
            job_report(&JobType::Move, Some(&output), true),
            Some(output.clone())
        );
        // Only a move has the duplicate; the other types return the lists untouched.
        let twice = json!({"destAfter": ["a.txt", "a.txt"]});
        assert_eq!(job_report(&JobType::Copy, Some(&twice), false), Some(twice));
        for job_type in [JobType::Sync, JobType::Copy] {
            assert_eq!(
                job_report(&job_type, Some(&output), false),
                Some(output.clone())
            );
        }
    }

    #[test]
    fn counts_cover_every_list_and_skip_what_is_not_a_list() {
        let counts = report_counts(&json!({
            "combined": ["+ a", "- b"], "match": [], "note": "text", "n": 3
        }));
        assert_eq!(
            counts,
            BTreeMap::from([("combined".into(), 2), ("match".into(), 0)])
        );
        assert!(report_counts(&json!(null)).is_empty());
    }
}
