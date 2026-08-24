use serde_json::Value;

use crate::utils::types::jobs::JobType;

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

/// Parses raw text output from `operations/cryptcheck` into structured JSON.
pub fn parse_cryptcheck_output(raw_result: &str) -> Value {
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
                if let Some(colon_pos) = rest.find(':') {
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

    let has_issues = !differ.is_empty()
        || !missing_on_dst.is_empty()
        || !missing_on_src.is_empty()
        || !error_list.is_empty();
    if has_issues {
        success = false;
        if status == "OK" {
            let mut parts = Vec::new();
            if !differ.is_empty() {
                parts.push(format!("{} differences", differ.len()));
            }
            if !missing_on_dst.is_empty() {
                parts.push(format!("{} missing on destination", missing_on_dst.len()));
            }
            if !missing_on_src.is_empty() {
                parts.push(format!("{} missing on source", missing_on_src.len()));
            }
            if !error_list.is_empty() {
                parts.push(format!("{} errors", error_list.len()));
            }
            status = format!("{} found", parts.join(", "));
        }
    }

    serde_json::json!({
        "results": [
            {
                "success": success,
                "status": status,
                "differ": differ,
                "missingOnDst": missing_on_dst,
                "missingOnSrc": missing_on_src,
                "error": error_list,
            }
        ]
    })
}

/// Evaluates job completion status and determines overall outcome, success/failure flags,
/// formatted error messages, and parsed cryptcheck output if applicable.
pub fn resolve_job_outcome(
    job_status: &Value,
    job_type: &JobType,
    source_paths: &[String],
) -> JobOutcome {
    let mut success = job_status
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let stopped = job_status
        .get("stopped")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut error_msg = job_status
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let mut cryptcheck_output = None;

    if success && let Some(output) = job_status.get("output") {
        if *job_type == JobType::CryptCheck
            && let Some(result_str) = output.get("result").and_then(|v| v.as_str())
        {
            let parsed = parse_cryptcheck_output(result_str);
            let first_result = parsed
                .get("results")
                .and_then(|r| r.as_array())
                .and_then(|a| a.first());
            let check_success = first_result
                .and_then(|r| r.get("success"))
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let check_status = first_result
                .and_then(|r| r.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("OK")
                .to_string();

            let has_parsed_issues = first_result
                .and_then(|r| r.get("differ"))
                .and_then(|a| a.as_array())
                .is_some_and(|a| !a.is_empty())
                || first_result
                    .and_then(|r| r.get("missingOnDst"))
                    .and_then(|a| a.as_array())
                    .is_some_and(|a| !a.is_empty())
                || first_result
                    .and_then(|r| r.get("missingOnSrc"))
                    .and_then(|a| a.as_array())
                    .is_some_and(|a| !a.is_empty())
                || first_result
                    .and_then(|r| r.get("error"))
                    .and_then(|a| a.as_array())
                    .is_some_and(|a| !a.is_empty());

            if has_parsed_issues {
                success = check_success;
                if !success {
                    error_msg = check_status;
                }
            } else if output
                .get("error")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                success = false;
                error_msg = result_str.trim().to_string();
            } else {
                success = true;
                error_msg = String::new();
            }
            cryptcheck_output = Some(parsed);
        }

        // 1. Check for operations/batch results
        if let Some(results) = output.get("results").and_then(|v| v.as_array()) {
            for res in results {
                let has_error = res.get("success").and_then(Value::as_bool) == Some(false)
                    || res
                        .get("status")
                        .and_then(Value::as_i64)
                        .is_some_and(|s| s >= 400)
                    || res.get("error").is_some_and(|e| match e {
                        Value::Null => false,
                        Value::Bool(b) => *b,
                        Value::String(s) => !s.trim().is_empty(),
                        Value::Array(arr) => !arr.is_empty(),
                        Value::Object(obj) => !obj.is_empty(),
                        _ => true,
                    });

                if has_error {
                    success = false;
                    let err = if let Some(e) = res.get("error") {
                        let formatted = match e {
                            Value::String(s) => s.clone(),
                            Value::Array(arr) => arr
                                .iter()
                                .filter_map(|v| v.as_str())
                                .collect::<Vec<_>>()
                                .join(", "),
                            _ => e.to_string(),
                        };
                        if formatted.trim().is_empty() {
                            if *job_type == JobType::Check {
                                res.get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Differences found")
                                    .to_string()
                            } else {
                                "Unknown error".to_string()
                            }
                        } else {
                            formatted
                        }
                    } else if *job_type == JobType::Check {
                        res.get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Differences found")
                            .to_string()
                    } else {
                        "Unknown error".to_string()
                    };

                    if !err.is_empty() {
                        let source_str = source_paths.join(", ");
                        let item_name = res
                            .get("input")
                            .and_then(|i| {
                                i.get("srcRemote")
                                    .or_else(|| i.get("remote"))
                                    .or_else(|| i.get("dstRemote"))
                                    .or_else(|| i.get("path1"))
                                    .or_else(|| i.get("path2"))
                            })
                            .and_then(|v| v.as_str())
                            .unwrap_or(&source_str);

                        let full_err = format!("{item_name}: {err}");
                        if error_msg.is_empty() {
                            error_msg = full_err;
                        } else if !error_msg.contains(&full_err) {
                            error_msg = format!("{error_msg}; {full_err}");
                        }
                    }
                }
            }
        }

        // 2. Check for individual command error (e.g. core/command)
        if success
            && output
                .get("error")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            success = false;
            if let Some(result) = output.get("result").and_then(|v| v.as_str())
                && !result.trim().is_empty()
            {
                error_msg = result.trim().to_string();
            }
        }

        // 3. Check for check operation results (e.g. operations/check)
        if success && *job_type == JobType::Check {
            let check_obj = if let Some(results) = output.get("results").and_then(|v| v.as_array())
            {
                results.first()
            } else {
                Some(output)
            };
            if let Some(check_obj) = check_obj
                && let Some(check_success) = check_obj.get("success").and_then(Value::as_bool)
                && !check_success
            {
                success = false;
                error_msg = check_obj
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("Differences found")
                    .to_string();
            }
        }
    }

    let final_error = (!error_msg.is_empty()).then_some(error_msg);

    JobOutcome {
        success,
        stopped,
        error_msg: final_error,
        cryptcheck_output,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let parsed = parse_cryptcheck_output(raw);
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
        let parsed = parse_cryptcheck_output(raw);
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
}
