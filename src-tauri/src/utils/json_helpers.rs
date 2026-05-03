use serde_json::Value;
use std::collections::HashMap;

/// Safely converts a JSON object to a `HashMap`.
/// Returns None if the input is not a JSON object.
#[must_use]
pub fn json_to_hashmap(json: Option<&Value>) -> Option<HashMap<String, Value>> {
    json.and_then(|v| v.as_object())
        .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
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
    json_to_hashmap(profile_cfg.get("options"))
}

/// Unwraps nested "options" key if it exists in a `HashMap`.
/// This handles the case where frontend sends { "options": { "key": "value" } }
/// and we need just { "key": "value" }.
#[must_use]
pub fn unwrap_nested_options(opts: HashMap<String, Value>) -> HashMap<String, Value> {
    if let Some(Value::Object(nested)) = opts.get("options") {
        nested.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    } else {
        opts
    }
}

/// Safely extracts a string value from a nested JSON path.
/// Returns an empty string if any key is not found or the final value is not a string.
#[must_use]
pub fn get_string(json: &Value, path: &[&str]) -> String {
    let mut current = Some(json);
    for key in path {
        current = current.and_then(|c| c.get(key));
    }
    current.and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// Evaluates safe macros wrapped in backticks — `` `macro` `` — replacing
/// each one with its resolved value.
///
/// Macros are used to provide dynamic values in paths and options without
/// the security risks of arbitrary shell execution.
///
/// Supported Macros:
/// - `` `date` ``: Current date in YYYY-MM-DD format.
/// - `` `date +FORMAT` ``: Current date with custom `strftime` formatting.
/// - `` `hostname` ``: The local system hostname.
/// - `` `whoami` `` / `` `user` ``: The current username.
/// - `` `os` ``: The operating system name (e.g., "linux", "windows").
///
/// If a macro is unknown or fails to resolve, the original `` `macro` `` token
/// is kept intact.
#[must_use]
pub fn interpolate_shell_commands(s: &str) -> String {
    if !s.contains('`') {
        return s.to_string();
    }

    let mut result = String::new();
    let mut remaining = s;

    while let Some(open) = remaining.find('`') {
        result.push_str(&remaining[..open]);
        let after_open = &remaining[open + 1..];

        let Some(close) = after_open.find('`') else {
            // Unmatched backtick — copy the rest verbatim and stop.
            result.push_str(&remaining[open..]);
            return result;
        };

        let cmd = &after_open[..close];
        result.push_str(&resolve_macro(cmd).unwrap_or_else(|| format!("`{cmd}`")));
        remaining = &after_open[close + 1..];
    }

    result.push_str(remaining);
    result
}

fn resolve_macro(cmd: &str) -> Option<String> {
    let cmd = cmd.trim();

    if cmd.starts_with("date") {
        let format = if cmd.len() > 4 && cmd.as_bytes()[4] == b' ' {
            let arg = cmd[5..].trim();
            if let Some(stripped) = arg.strip_prefix('+') {
                stripped
            } else {
                arg
            }
        } else {
            "%Y-%m-%d"
        };
        // Use chrono for cross-platform, safe date formatting
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

/// Utility to normalize Windows extended-length paths (e.g., //?/C:/path or \\?\C:\path) to C:/path, only on Windows
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
        // Default is YYYY-MM-DD (10 chars)
        assert_eq!(result.trim().len(), "backup_".len() + 10);
    }

    #[test]
    fn test_date_expands_custom_format() {
        let result = interpolate_shell_commands("year_`date +%Y`_month_`date +%m` ");
        assert!(!result.contains('`'));
        assert!(result.contains("year_20")); // Assuming year is 20xx
        assert!(result.contains("_month_"));
    }

    #[test]
    fn test_date_complex_format() {
        let result = interpolate_shell_commands("`date +%A, %d %B %Y` ");
        assert!(!result.contains('`'));
        // Example: "Saturday, 02 May 2026"
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
