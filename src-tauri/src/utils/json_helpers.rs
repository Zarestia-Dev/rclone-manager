use serde_json::Value;
use std::collections::HashMap;

/// Safely converts a JSON object to a `HashMap`.
/// Returns None if the input is not a JSON object.
#[must_use]
pub fn json_to_hashmap(json: Option<&Value>) -> Option<HashMap<String, Value>> {
    let obj = json?.as_object()?;
    Some(obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// Resolve profile options from a settings object.
/// Looks up `settings[configs_key][profile_name]["options"]` and returns it as a `HashMap`.
///
/// This is used by `from_config` methods to resolve filter, backend, and VFS profiles.
#[must_use]
pub fn resolve_profile_options(
    settings: &Value,
    profile_name: Option<&str>,
    configs_key: &str,
) -> Option<HashMap<String, Value>> {
    let name = profile_name?;
    let configs = settings.get(configs_key)?.as_object()?;
    let profile_cfg = configs.get(name)?;
    json_to_hashmap(Some(profile_cfg))
}

/// Safely extracts a string value from a nested JSON path.
/// Returns an empty string if any key is not found or the final value is not a string.
#[must_use]
pub fn get_string(json: &Value, path: &[&str]) -> String {
    path.iter()
        .try_fold(json, |acc, &key| acc.get(key))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Evaluates safe macros wrapped in either backticks — `` `macro` `` — or
/// shell-style command substitution — `$(macro)` — replacing each one with
/// its resolved value.
///
/// Macros are used to provide dynamic values in paths and options without
/// the security risks of arbitrary shell execution.
///
/// Supported Macros:
/// - `date`: Current date in YYYY-MM-DD format.
/// - `date +FORMAT`: Current date with custom `strftime` formatting.
/// - `hostname`: The local system hostname.
/// - `whoami` / `user`: The current username.
/// - `os`: The operating system name (e.g., "linux", "windows").
///
/// If a macro is unknown or fails to resolve, the original token is kept intact.
#[must_use]
pub fn interpolate_shell_commands(s: &str) -> String {
    let mut result = s.to_string();

    // Support both `macro` and $(macro) syntax
    result = interpolate_pattern(&result, "`", "`");
    result = interpolate_pattern(&result, "$(", ")");

    result
}

fn interpolate_pattern(s: &str, open_delim: &str, close_delim: &str) -> String {
    if !s.contains(open_delim) {
        return s.to_string();
    }

    let mut result = String::new();
    let mut remaining = s;

    while let Some(open) = remaining.find(open_delim) {
        result.push_str(&remaining[..open]);
        let after_open = &remaining[open + open_delim.len()..];

        let Some(close) = after_open.find(close_delim) else {
            // Unmatched delimiter — copy the rest verbatim and stop.
            result.push_str(&remaining[open..]);
            return result;
        };

        let cmd = &after_open[..close];
        if let Some(resolved) = resolve_macro(cmd) {
            result.push_str(&resolved);
        } else {
            // Keep original if unresolved
            result.push_str(open_delim);
            result.push_str(cmd);
            result.push_str(close_delim);
        }
        remaining = &after_open[close + close_delim.len()..];
    }

    result.push_str(remaining);
    result
}

fn resolve_macro(cmd: &str) -> Option<String> {
    let cmd = cmd.trim();

    if cmd == "date" {
        return Some(chrono::Local::now().format("%Y-%m-%d").to_string());
    } else if let Some(args) = cmd.strip_prefix("date ") {
        let arg = args.trim();
        let format = arg.strip_prefix('+').unwrap_or(arg);
        return Some(chrono::Local::now().format(format).to_string());
    }

    match cmd {
        "hostname" => sysinfo::System::host_name(),
        "whoami" | "user" => std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .ok(),
        "os" => Some(std::env::consts::OS.to_string()),
        _ => None,
    }
}

/// Recursively applies [`interpolate_shell_commands`] to every string inside a
/// JSON value, leaving non-string values unchanged.
pub fn interpolate_value(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(interpolate_shell_commands(s)),
        Value::Object(map) => {
            let new_map = map
                .iter()
                .map(|(k, v)| (k.clone(), interpolate_value(v)))
                .collect::<serde_json::Map<String, Value>>();
            Value::Object(new_map)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(interpolate_value).collect()),
        _ => value.clone(),
    }
}

/// Utility to normalize Windows extended-length paths (e.g., //?/<<C:/path>> or \\?\C:\path) to <<C:/path>>, only on Windows
#[must_use]
pub fn normalize_windows_path(path: &str) -> String {
    let mut p = path;
    if p.starts_with("//?/") || p.starts_with(r"\\?\") {
        p = &p[4..];
    }
    p.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_json_to_hashmap() {
        assert!(json_to_hashmap(None).is_none());
        assert!(json_to_hashmap(Some(&json!(123))).is_none());
        assert!(json_to_hashmap(Some(&json!("string"))).is_none());

        let v = json!({ "a": 1, "b": "hello" });
        let map = json_to_hashmap(Some(&v)).unwrap();
        assert_eq!(map.get("a").unwrap(), &json!(1));
        assert_eq!(map.get("b").unwrap(), &json!("hello"));
    }

    #[test]
    fn test_resolve_profile_options() {
        let settings = json!({
            "vfsConfigs": {
                "profile1": {
                    "vfs-cache-mode": "writes",
                    "read-only": true
                }
            }
        });

        assert!(resolve_profile_options(&settings, None, "vfsConfigs").is_none());
        assert!(resolve_profile_options(&settings, Some("profile2"), "vfsConfigs").is_none());
        assert!(resolve_profile_options(&settings, Some("profile1"), "missingConfigs").is_none());

        let opts = resolve_profile_options(&settings, Some("profile1"), "vfsConfigs").unwrap();
        assert_eq!(opts.get("vfs-cache-mode").unwrap(), "writes");
        assert_eq!(opts.get("read-only").unwrap(), &json!(true));
    }

    #[test]
    fn test_get_string() {
        let v = json!({
            "nested": {
                "target": "found_me",
                "number": 42
            }
        });

        assert_eq!(get_string(&v, &["nested", "target"]), "found_me");
        assert_eq!(get_string(&v, &["nested", "number"]), "");
        assert_eq!(get_string(&v, &["nested", "missing"]), "");
        assert_eq!(get_string(&v, &["nonexistent"]), "");
    }

    #[test]
    fn test_normalize_windows_path() {
        assert_eq!(normalize_windows_path("//?/C:/foo/bar"), "C:/foo/bar");
        assert_eq!(normalize_windows_path(r"\\?\C:\foo\bar"), r"C:\foo\bar");
        assert_eq!(normalize_windows_path("C:/foo/bar"), "C:/foo/bar");
        assert_eq!(normalize_windows_path(""), "");
    }

    #[test]
    fn test_no_backtick_is_passthrough() {
        let s = "pCloud:backups/static_folder";
        assert_eq!(interpolate_shell_commands(s), s);
    }

    #[test]
    fn test_unmatched_backtick_left_intact() {
        let s = "prefix_`no_close";
        assert_eq!(interpolate_shell_commands(s), s);
    }

    #[test]
    fn test_date_expands_default() {
        let result = interpolate_shell_commands("backup_`date` ");
        assert!(result.starts_with("backup_"));
        assert!(!result.contains('`'));
        assert_eq!(result.trim().len(), "backup_".len() + 10);
    }

    #[test]
    fn test_date_expands_custom_format() {
        let result = interpolate_shell_commands("year_`date +%Y`_month_`date +%m` ");
        assert!(!result.contains('`'));
        assert!(result.contains("year_20"));
        assert!(result.contains("_month_"));
    }

    #[test]
    fn test_date_complex_format() {
        let result = interpolate_shell_commands("`date +%A, %d %B %Y` ");
        assert!(!result.contains('`'));
        assert!(result.len() > 10);
    }

    #[test]
    fn test_multiple_expressions() {
        let result = interpolate_shell_commands("`os`/`user`/`date +%Y` ");
        assert!(!result.contains('`'));
        assert!(result.contains('/'));
    }

    #[test]
    fn test_unknown_command_left_intact() {
        let s = "prefix_`unknown_macro_123`_suffix";
        assert_eq!(interpolate_shell_commands(s), s);
    }

    #[test]
    fn test_dollar_paren_syntax() {
        let result = interpolate_shell_commands("pCloud_$(date +%Y-%m-%d)");
        assert!(!result.contains("$("));
        assert!(result.starts_with("pCloud_20"));
    }

    #[test]
    fn test_mixed_syntax() {
        let result = interpolate_shell_commands("`user`_$(date +%Y)");
        assert!(!result.contains('`'));
        assert!(!result.contains("$("));
        assert!(result.contains("_20"));
    }

    #[test]
    fn test_unmatched_dollar_paren() {
        let s = "prefix_$(no_close";
        assert_eq!(interpolate_shell_commands(s), s);
    }

    #[test]
    fn test_interpolate_value_recurses() {
        let v = serde_json::json!({
            "plain": "no_backticks",
            "nested": { "also_plain": "no_backticks" },
            "count": 42,
        });
        let result = interpolate_value(&v);
        assert_eq!(result["plain"], "no_backticks");
        assert_eq!(result["nested"]["also_plain"], "no_backticks");
        assert_eq!(result["count"], 42);
    }
}
