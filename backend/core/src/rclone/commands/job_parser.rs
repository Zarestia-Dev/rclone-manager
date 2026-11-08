use serde_json::{Value, json};

use crate::utils::types::jobs::JobType;

/// Message boundaries emitted by rclone's check/cryptcheck implementations.
const CRYPTCHECK_ERROR_BOUNDARIES: &[&str] = &[
    ": file not in ",
    ": hashes differ",
    ": Sizes differ",
    ": sizes differ",
    ": MD5 differ",
    ": files differ",
    ": error ",
    ": Failed ",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobOutcome {
    pub success: bool,
    pub stopped: bool,
    pub error_msg: Option<String>,
    pub cryptcheck_output: Option<Value>,
}

/// Parses the job ID from an rclone JSON response.
/// Supports both numeric `{"jobid": 123}` and string `{"id": "123"}` fields.
pub fn parse_job_response(response_json: &Value) -> Result<u64, String> {
    response_json
        .get("jobid")
        .and_then(serde_json::Value::as_u64)
        .or_else(|| {
            response_json
                .get("id")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok())
        })
        .ok_or_else(|| {
            crate::localized_error!(
                "backendErrors.request.failed",
                "error" => "missing job id in response"
            )
        })
}

/// What `operations/cryptcheck` reported, read from its text output.
#[derive(Debug, PartialEq)]
pub struct CryptcheckReport {
    success: bool,
    status: String,
    differ: Vec<String>,
    missing_on_dst: Vec<String>,
    missing_on_src: Vec<String>,
    errors: Vec<String>,
}

impl CryptcheckReport {
    fn has_issues(&self) -> bool {
        !(self.differ.is_empty()
            && self.missing_on_dst.is_empty()
            && self.missing_on_src.is_empty()
            && self.errors.is_empty())
    }

    /// The same shape `operations/check` returns, which is what the job stores and the UI reads.
    pub fn to_output(&self) -> Value {
        json!({
            "results": [
                {
                    "success": self.success,
                    "status": self.status,
                    "differ": self.differ,
                    "missingOnDst": self.missing_on_dst,
                    "missingOnSrc": self.missing_on_src,
                    "error": self.errors,
                }
            ]
        })
    }
}

/// Reads the text output of `operations/cryptcheck`.
pub fn parse_cryptcheck_output(raw_result: &str) -> CryptcheckReport {
    let mut differ = Vec::new();
    let mut missing_on_dst = Vec::new();
    let mut missing_on_src = Vec::new();
    let mut error_list = Vec::new();
    let mut success = true;
    let mut status = "OK".to_string();

    for line in raw_result.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let is_error = line.contains("ERROR :") || line.contains("ERROR:");
        let is_notice = line.contains("NOTICE:") || line.contains("NOTICE :");

        if is_error {
            let pos = line
                .find("ERROR :")
                .map(|p| p + 7)
                .or_else(|| line.find("ERROR:").map(|p| p + 6));
            if let Some(start_idx) = pos {
                let rest = &line[start_idx..];
                // The filename can contain colons. Match rclone's message boundary.
                let boundary = CRYPTCHECK_ERROR_BOUNDARIES
                    .iter()
                    .filter_map(|marker| rest.find(marker))
                    .min();
                if let Some(colon_pos) = boundary {
                    let path = rest[..colon_pos].trim().to_string();
                    let msg = rest[colon_pos + 1..].trim();

                    if msg.contains("file not in Encrypted drive") {
                        missing_on_dst.push(path);
                    } else if msg.contains("file not in") {
                        missing_on_src.push(path);
                    } else if msg.to_lowercase().contains("differ") {
                        differ.push(path);
                    } else {
                        error_list.push(format!("{}: {}", path, msg));
                    }
                } else {
                    error_list.push(rest.trim().to_string());
                }
            }
        } else if is_notice {
            let pos = line
                .find("NOTICE :")
                .map(|p| p + 8)
                .or_else(|| line.find("NOTICE:").map(|p| p + 7));
            if let Some(start_idx) = pos {
                let rest = &line[start_idx..];
                if rest.contains("Skipping undecryptable dir name") {
                    if let Some(colon_pos) = rest.find(':') {
                        let path = rest[..colon_pos].trim().to_string();
                        let msg = rest[colon_pos + 1..].trim();
                        error_list.push(format!("{}: {}", path, msg));
                    }
                } else if (rest.contains("differences found")
                    && !rest.contains("0 differences found"))
                    || (status == "OK"
                        && (rest.contains("errors while checking")
                            || rest.contains("files missing")))
                {
                    status = rest.trim().to_string();
                    success = false;
                }
            }
        }
    }

    let mut report = CryptcheckReport {
        success,
        status,
        differ,
        missing_on_dst,
        missing_on_src,
        errors: error_list,
    };
    if report.has_issues() {
        report.success = false;
        if report.status == "OK" {
            let counts = [
                (report.differ.len(), "differences"),
                (report.missing_on_dst.len(), "missing on destination"),
                (report.missing_on_src.len(), "missing on source"),
                (report.errors.len(), "errors"),
            ];
            let parts: Vec<String> = counts
                .iter()
                .filter(|(count, _)| *count > 0)
                .map(|(count, what)| format!("{count} {what}"))
                .collect();
            report.status = format!("{} found", parts.join(", "));
        }
    }
    report
}

/// Evaluates job completion status and determines overall outcome, success/failure flags,
/// formatted error messages, and parsed cryptcheck output if applicable.
pub fn resolve_job_outcome(
    job_status: &Value,
    job_type: &JobType,
    source_paths: &[String],
) -> JobOutcome {
    let error = job_status
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let mut outcome = JobOutcome {
        success: job_status
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        stopped: job_status
            .get("stopped")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        error_msg: (!error.is_empty()).then(|| error.to_string()),
        cryptcheck_output: None,
    };

    if outcome.success
        && let Some(output) = job_status.get("output")
    {
        if *job_type == JobType::CryptCheck {
            apply_cryptcheck_output(&mut outcome, output);
        }
        apply_batch_results(&mut outcome, output, job_type, source_paths);
        apply_command_error(&mut outcome, output);
        if *job_type == JobType::Check {
            apply_check_result(&mut outcome, output);
        }
    }
    outcome
}

fn output_flags_error(output: &Value) -> bool {
    output
        .get("error")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// `operations/cryptcheck` answers with text; what it found decides the outcome.
fn apply_cryptcheck_output(outcome: &mut JobOutcome, output: &Value) {
    let Some(raw) = output.get("result").and_then(Value::as_str) else {
        return;
    };
    let report = parse_cryptcheck_output(raw);
    if report.has_issues() {
        outcome.success = false;
        outcome.error_msg = Some(report.status.clone());
    } else if output_flags_error(output) {
        outcome.success = false;
        outcome.error_msg = Some(raw.trim().to_string());
    } else {
        outcome.success = true;
        outcome.error_msg = None;
    }
    outcome.cryptcheck_output = Some(report.to_output());
}

/// Whether the `error` of a batch result says something went wrong.
fn error_is_set(error: &Value) -> bool {
    match error {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
        _ => true,
    }
}

/// The failure text of one batch result: `None` while it succeeded, an empty text when it
/// failed without saying why.
fn batch_failure(result: &Value, job_type: &JobType) -> Option<String> {
    let failed = result.get("success").and_then(Value::as_bool) == Some(false)
        || result
            .get("status")
            .and_then(Value::as_i64)
            .is_some_and(|status| status >= 400)
        || result.get("error").is_some_and(error_is_set);
    if !failed {
        return None;
    }
    let from_error = result.get("error").map(|error| match error {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", "),
        other => other.to_string(),
    });
    Some(match from_error.filter(|text| !text.trim().is_empty()) {
        Some(text) => text,
        None if *job_type == JobType::Check => result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("Differences found")
            .to_string(),
        None => "Unknown error".to_string(),
    })
}

/// `job/batch` and `operations/batch` answer with one result per input.
fn apply_batch_results(
    outcome: &mut JobOutcome,
    output: &Value,
    job_type: &JobType,
    source_paths: &[String],
) {
    let Some(results) = output.get("results").and_then(Value::as_array) else {
        return;
    };
    for result in results {
        let Some(error) = batch_failure(result, job_type) else {
            continue;
        };
        outcome.success = false;
        if error.is_empty() {
            continue;
        }
        let source = source_paths.join(", ");
        let item = result
            .get("input")
            .and_then(|input| {
                ["srcRemote", "remote", "dstRemote", "path1", "path2"]
                    .iter()
                    .find_map(|key| input.get(*key))
            })
            .and_then(Value::as_str)
            .unwrap_or(&source);
        let full = format!("{item}: {error}");
        match outcome.error_msg.as_mut() {
            None => outcome.error_msg = Some(full),
            Some(message) if !message.contains(&full) => {
                *message = format!("{message}; {full}");
            }
            Some(_) => {}
        }
    }
}

/// A single command (`core/command`) reports its failure in the output itself.
fn apply_command_error(outcome: &mut JobOutcome, output: &Value) {
    if !outcome.success || !output_flags_error(output) {
        return;
    }
    outcome.success = false;
    if let Some(result) = output.get("result").and_then(Value::as_str)
        && !result.trim().is_empty()
    {
        outcome.error_msg = Some(result.trim().to_string());
    }
}

/// `operations/check` succeeds as a call even when it found differences.
fn apply_check_result(outcome: &mut JobOutcome, output: &Value) {
    if !outcome.success {
        return;
    }
    let result = match output.get("results").and_then(Value::as_array) {
        Some(results) => results.first(),
        None => Some(output),
    };
    if let Some(result) = result
        && result.get("success").and_then(Value::as_bool) == Some(false)
    {
        outcome.success = false;
        outcome.error_msg = Some(
            result
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("Differences found")
                .to_string(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cryptcheck_message_paths_do_not_override_the_error_boundary() {
        for suffix in [": Failed backup", ": error archive", ": hashes differ"] {
            let output = parse_cryptcheck_output(&format!(
                "ERROR : a.txt: file not in Local file system at /tmp/root{suffix}"
            ))
            .to_output();
            assert_eq!(output["results"][0]["missingOnSrc"], json!(["a.txt"]));
            assert_eq!(output["results"][0]["error"], json!([]));
        }
    }

    #[test]
    fn cryptcheck_reports_keep_colons_in_file_names() {
        let text = "2026/10/20 12:00:00 ERROR : folder/a:b.txt: file not in Encrypted drive 'dst:'\n2026/10/20 12:00:00 ERROR : folder/a: b.txt: hashes differ (dst:path)\n2026/10/20 12:00:00 ERROR : other:c.txt: file not in Local file system at /src\n";
        let output = parse_cryptcheck_output(text).to_output();
        let result = &output["results"][0];
        assert_eq!(result["missingOnDst"], json!(["folder/a:b.txt"]));
        assert_eq!(result["differ"], json!(["folder/a: b.txt"]));
        assert_eq!(result["missingOnSrc"], json!(["other:c.txt"]));
        assert_eq!(result["success"], false);
        let output =
            parse_cryptcheck_output("ERROR : file:a: unfamiliar failure with: details").to_output();
        assert_eq!(
            output["results"][0]["error"],
            json!(["file:a: unfamiliar failure with: details"])
        );
    }

    #[test]
    fn test_parse_job_response_numeric() {
        let json = serde_json::json!({ "jobid": 42 });
        assert_eq!(parse_job_response(&json).unwrap(), 42);
    }

    #[test]
    fn test_parse_job_response_string_id() {
        let json = serde_json::json!({ "id": "99" });
        assert_eq!(parse_job_response(&json).unwrap(), 99);
    }

    #[test]
    fn test_parse_job_response_missing_id_returns_err() {
        let json = serde_json::json!({ "other": 123 });
        assert!(parse_job_response(&json).is_err());
    }

    #[test]
    fn test_parse_cryptcheck_output_success() {
        let raw = "2026/08/20 10:00:00 NOTICE: Encrypted drive 'enc:': 0 differences found\n";
        let parsed = parse_cryptcheck_output(raw).to_output();
        let res = &parsed["results"][0];
        assert_eq!(res["success"], true);
        assert_eq!(res["status"], "OK");
        assert!(res["differ"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_parse_cryptcheck_output_with_differences() {
        let raw = r#"
2026/08/20 10:00:00 ERROR : file1.txt: MD5 differ
2026/08/20 10:00:00 ERROR : file2.txt: file not in Encrypted drive
2026/08/20 10:00:00 NOTICE: Encrypted drive 'enc:': 1 differences found
"#;
        let parsed = parse_cryptcheck_output(raw).to_output();
        let res = &parsed["results"][0];
        assert_eq!(res["success"], false);
        assert_eq!(
            res["differ"].as_array().unwrap(),
            &vec![serde_json::json!("file1.txt")]
        );
        assert_eq!(
            res["missingOnDst"].as_array().unwrap(),
            &vec![serde_json::json!("file2.txt")]
        );
    }

    #[test]
    fn test_resolve_job_outcome_stopped() {
        let status = serde_json::json!({
            "finished": true,
            "success": false,
            "stopped": true
        });
        let outcome = resolve_job_outcome(&status, &JobType::Sync, &["src".to_string()]);
        assert!(!outcome.success);
        assert!(outcome.stopped);
        assert!(outcome.error_msg.is_none());
    }

    #[test]
    fn test_resolve_job_outcome_check_differences() {
        let status = serde_json::json!({
            "finished": true,
            "success": true,
            "output": {
                "results": [{
                    "success": false,
                    "status": "3 differences found",
                    "differ": ["a.txt", "b.txt", "c.txt"]
                }]
            }
        });
        let outcome = resolve_job_outcome(&status, &JobType::Check, &["src".to_string()]);
        assert!(!outcome.success);
        assert!(!outcome.stopped);
        assert_eq!(
            outcome.error_msg.as_deref(),
            Some("src: 3 differences found")
        );
    }

    #[test]
    fn batch_failures_are_named_by_input_and_not_repeated() {
        let status = json!({
            "finished": true,
            "success": true,
            "output": {"results": [
                {"input": {"srcRemote": "a:"}, "error": "boom", "status": 500},
                {"input": {"srcRemote": "a:"}, "error": "boom", "status": 500},
                {"success": true},
                {"error": ["x", "y"]},
                {"status": 404},
            ]}
        });
        let outcome = resolve_job_outcome(&status, &JobType::Copy, &["src".to_string()]);
        assert!(!outcome.success);
        assert_eq!(
            outcome.error_msg.as_deref(),
            Some("a:: boom; src: x, y; src: Unknown error")
        );
    }

    #[test]
    fn a_command_that_reports_an_error_fails_the_job_with_its_text() {
        let status = json!({
            "finished": true,
            "success": true,
            "output": {"error": true, "result": " disk full \n"}
        });
        let outcome = resolve_job_outcome(&status, &JobType::Unknown("cmd".into()), &[]);
        assert!(!outcome.success);
        assert_eq!(outcome.error_msg.as_deref(), Some("disk full"));
        // A failed job keeps its own error and is not looked into further.
        let failed = json!({"finished": true, "success": false, "error": " nope ",
            "output": {"error": true, "result": "other"}});
        let outcome = resolve_job_outcome(&failed, &JobType::Sync, &[]);
        assert_eq!(outcome.error_msg.as_deref(), Some("nope"));
    }

    #[test]
    fn a_clean_cryptcheck_succeeds_and_a_noisy_one_fails_with_a_summary() {
        let clean = json!({"finished": true, "success": true,
            "output": {"result": "NOTICE: Encrypted drive 'enc:': 0 differences found"}});
        let outcome = resolve_job_outcome(&clean, &JobType::CryptCheck, &[]);
        assert!(outcome.success);
        assert!(outcome.error_msg.is_none());
        assert!(outcome.cryptcheck_output.is_some());

        let differing = json!({"finished": true, "success": true,
            "output": {"result": "ERROR : a.txt: MD5 differ\nERROR : b.txt: file not in Encrypted drive"}});
        let outcome = resolve_job_outcome(&differing, &JobType::CryptCheck, &[]);
        assert!(!outcome.success);
        assert_eq!(
            outcome.error_msg.as_deref(),
            Some("1 differences, 1 missing on destination found")
        );
    }
}
