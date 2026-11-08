//! What rclone reports about the files of a finished sync, copy, move or bisync job.
//!
//! A bisync job reports no list of its conflicts, only the log it wrote. The conflicts are read
//! from that log, which every rclone version writes the same way.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::utils::types::jobs::JobType;

/// Keeps the reports of a finished sync, copy or move job, or the `conflicts` of a bisync job (the
/// files that changed on both paths, read from its log). Other jobs return other output, and
/// without a report parameter rclone returns an empty object, which is not worth keeping.
///
/// `had_errors` is whether the job failed or counted an error. A move deletes the source of a file
/// that is already identical on the destination, and rclone logs the result of that delete as an
/// error even when there is none: the file shows up as `! path` in `combined`, in `error`, and a
/// second time in `destAfter`. With no error to explain them, the `!` entries are dropped. The
/// duplicate in `destAfter` goes either way, as a listing never holds a path twice.
#[must_use]
pub fn job_report(job_type: &JobType, output: Option<&Value>, had_errors: bool) -> Option<Value> {
    if matches!(job_type, JobType::Bisync) {
        return bisync_conflicts(output?);
    }
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

/// The conflicts of a bisync run as a report of their own, `None` when there were none.
fn bisync_conflicts(output: &Value) -> Option<Value> {
    let conflicts: Vec<Value> = bisync_logs(output)
        .into_iter()
        .flat_map(conflicts_in_log)
        .collect();
    (!conflicts.is_empty()).then(|| serde_json::json!({ "conflicts": conflicts }))
}

/// The log of every bisync a job ran: one for `sync/bisync`, one per input for `job/batch`.
fn bisync_logs(output: &Value) -> Vec<&str> {
    match output.get("results").and_then(Value::as_array) {
        Some(results) => results
            .iter()
            .filter_map(|result| result.get("output")?.as_str())
            .collect(),
        None => output
            .get("output")
            .and_then(Value::as_str)
            .into_iter()
            .collect(),
    }
}

/// Without a winner, bisync keeps both versions of a file that changed on both paths: it names
/// the file in a warning, then renames each path's copy and copies it to the other path.
///
/// ```text
/// NOTICE: - WARNING  New or changed in both paths       - notes/a.txt
/// NOTICE: - Path1    Renaming Path1 copy                - /one/notes/a.txt.conflict1
/// NOTICE: - Path2    Renaming Path2 copy                - /two/notes/a.txt.conflict2
/// ```
///
/// A file counts when both of its copies were renamed. A conflict bisync settled some other way
/// (a winner, or a deleted loser) has no pair of copies to choose between and is left out.
fn conflicts_in_log(log: &str) -> Vec<Value> {
    const BOTH_CHANGED: &str = "New or changed in both paths";
    let mut names: Vec<String> = Vec::new();
    let mut copies: Vec<(Option<String>, Option<String>)> = Vec::new();
    for line in log.lines().map(strip_ansi) {
        if let Some(name) = text_after(&line, BOTH_CHANGED) {
            names.push(name.to_string());
            copies.push((None, None));
        } else if let Some(path) = text_after(&line, "Renaming Path1 copy") {
            if let Some((index, renamed)) = owner(&names, path) {
                copies[index].0 = Some(renamed);
            }
        } else if let Some(path) = text_after(&line, "Renaming Path2 copy")
            && let Some((index, renamed)) = owner(&names, path)
        {
            copies[index].1 = Some(renamed);
        }
    }
    names
        .into_iter()
        .zip(copies)
        .filter_map(|(name, copies)| match copies {
            (Some(path1_now), Some(path2_now)) => Some(serde_json::json!({
                "path": name, "path1Now": path1_now, "path2Now": path2_now,
            })),
            _ => None,
        })
        .collect()
}

/// What follows `marker` and the dash after it, e.g. the file name of a bisync log line.
fn text_after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    let rest = &line[line.find(marker)? + marker.len()..];
    rest.trim_start().strip_prefix("- ").map(str::trim)
}

/// The file that `path` is a renamed copy of, with the name it has now, relative to its path.
/// The longest name wins, so `a.txt` does not claim a copy of `dir/a.txt`.
fn owner(names: &[String], path: &str) -> Option<(usize, String)> {
    names
        .iter()
        .enumerate()
        .filter_map(|(index, name)| Some((index, name.len(), renamed_name(name, path)?)))
        .max_by_key(|(_, length, _)| *length)
        .map(|(index, _, renamed)| (index, renamed))
}

/// `name` and the suffix `path` adds to it, when `path` is that name in the same folder under a
/// longer name.
fn renamed_name(name: &str, path: &str) -> Option<String> {
    let start = path.rfind(name)?;
    let tail = &path[start + name.len()..];
    let starts_a_name = start == 0 || path[..start].ends_with(['/', '\\', ':']);
    (starts_a_name && !tail.is_empty() && !tail.contains(['/', '\\']))
        .then(|| format!("{name}{tail}"))
}

/// The line without the colour codes rclone writes when it logs to a terminal.
fn strip_ansi(line: &str) -> String {
    let mut plain = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            for code in chars.by_ref() {
                if code.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            plain.push(character);
        }
    }
    plain
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

    /// A conflict as an rclone writes it to a terminal, colour codes included.
    const COLOURED: &str = "2026/11/08 19:25:20 NOTICE: - \x1b[34mWARNING\x1b[0m  \x1b[35mNew or changed in both paths\x1b[0m       - \x1b[36mf.txt\x1b[0m
2026/11/08 19:25:20 NOTICE: - \x1b[36mPath1\x1b[0m    \x1b[35mRenaming Path1 copy\x1b[0m                - \x1b[36m/home/me/a/f.txt.conflict1\x1b[0m
2026/11/08 19:25:20 NOTICE: - \x1b[36mPath1\x1b[0m    \x1b[35m\x1b[32mQueue copy to\x1b[0m Path2\x1b[0m       - \x1b[36m/home/me/b/f.txt.conflict1\x1b[0m
2026/11/08 19:25:20 NOTICE: - \x1b[34mPath2\x1b[0m    \x1b[35mRenaming Path2 copy\x1b[0m                - \x1b[36m/home/me/b/f.txt.conflict2\x1b[0m
";

    fn conflict(name: &str, one: &str, two: &str) -> Value {
        json!({ "path": name, "path1Now": one, "path2Now": two })
    }

    #[test]
    fn a_bisync_job_reads_its_conflicts_from_its_log() {
        let output = json!({ "output": COLOURED, "session": "s", "workDir": "/w" });
        assert_eq!(
            job_report(&JobType::Bisync, Some(&output), false),
            Some(json!({ "conflicts": [conflict("f.txt", "f.txt.conflict1", "f.txt.conflict2")] }))
        );
    }

    #[test]
    fn conflicts_are_matched_to_their_files_in_any_order() {
        // All the warnings come before the renames, and two files share a name.
        let log = "NOTICE: - WARNING  New or changed in both paths       - a.txt
NOTICE: - WARNING  New or changed in both paths       - dir/a.txt
NOTICE: - Path1    Renaming Path1 copy                - drive:x/dir/a.txt.conflict1
NOTICE: - Path1    Renaming Path1 copy                - drive:x/a.txt.conflict1
NOTICE: - Path2    Renaming Path2 copy                - /two/a.txt.conflict2
NOTICE: - Path2    Renaming Path2 copy                - /two/dir/a.txt.conflict2
";
        assert_eq!(
            conflicts_in_log(log),
            vec![
                conflict("a.txt", "a.txt.conflict1", "a.txt.conflict2"),
                conflict("dir/a.txt", "dir/a.txt.conflict1", "dir/a.txt.conflict2"),
            ]
        );
    }

    #[test]
    fn a_name_with_spaces_and_unicode_survives() {
        let log =
            "NOTICE: - WARNING  New or changed in both paths       - notes/Ünicode ğ dosyası.txt
NOTICE: - Path1    Renaming Path1 copy                - /a/notes/Ünicode ğ dosyası.txt.conflict3
NOTICE: - Path2    Renaming Path2 copy                - /b/notes/Ünicode ğ dosyası.txt.conflict4
";
        assert_eq!(
            conflicts_in_log(log),
            vec![conflict(
                "notes/Ünicode ğ dosyası.txt",
                "notes/Ünicode ğ dosyası.txt.conflict3",
                "notes/Ünicode ğ dosyası.txt.conflict4"
            )]
        );
    }

    #[test]
    fn a_conflict_without_both_copies_renamed_is_left_out() {
        // A winner was preferred: only the loser's copy was renamed.
        let log = "NOTICE: - WARNING  New or changed in both paths       - a.txt
NOTICE: - Path2    Renaming Path2 copy                - /two/a.txt.conflict2
NOTICE: - WARNING  New or changed in both paths       - b.txt
";
        assert!(conflicts_in_log(log).is_empty());
    }

    #[test]
    fn a_bisync_without_conflicts_keeps_no_report() {
        for output in [
            json!({"output": "INFO  : Bisync successful"}),
            json!({"output": 7}),
            json!({"conflicts": [{"path1": "a"}]}),
            json!({}),
            json!(null),
        ] {
            assert_eq!(job_report(&JobType::Bisync, Some(&output), false), None);
        }
        assert_eq!(job_report(&JobType::Bisync, None, false), None);
    }

    #[test]
    fn a_batch_of_bisyncs_joins_their_conflicts() {
        let first = "NOTICE: - WARNING  New or changed in both paths       - a
NOTICE: - Path1    Renaming Path1 copy                - /1/a.conflict1
NOTICE: - Path2    Renaming Path2 copy                - /2/a.conflict2
";
        let second = first.replace(" a", " b").replace("/a.", "/b.");
        let output = json!({"results": [
            {"output": first},
            {"output": "nothing changed"},
            {"output": second},
        ]});
        assert_eq!(
            job_report(&JobType::Bisync, Some(&output), false),
            Some(json!({ "conflicts": [
                conflict("a", "a.conflict1", "a.conflict2"),
                conflict("b", "b.conflict1", "b.conflict2"),
            ] }))
        );
    }

    #[test]
    fn only_sync_copy_and_move_keep_a_non_empty_file_report() {
        let output = json!({"combined": ["+ a.txt"]});
        for job_type in [JobType::Sync, JobType::Copy, JobType::Move] {
            assert_eq!(
                job_report(&job_type, Some(&output), false),
                Some(output.clone())
            );
        }
        for job_type in [JobType::Check, JobType::List, JobType::Mount] {
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
