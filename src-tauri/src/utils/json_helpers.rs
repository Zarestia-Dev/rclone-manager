use serde_json::Value;
use std::collections::HashMap;

/// Safely converts a JSON object to a HashMap.
/// Returns None if the input is not a JSON object.
pub fn json_to_hashmap(json: Option<&Value>) -> Option<HashMap<String, Value>> {
    json.and_then(|v| v.as_object())
        .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// Resolve profile options from a settings object.
/// Looks up `settings[configs_key][profile_name]["options"]` and returns it as a HashMap.
///
/// This is used by `from_config` methods to resolve filter, backend, and VFS profiles.
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

/// Unwraps nested "options" key if it exists in a HashMap.
/// This handles the case where frontend sends { "options": { "key": "value" } }
/// and we need just { "key": "value" }.
pub fn unwrap_nested_options(opts: HashMap<String, Value>) -> HashMap<String, Value> {
    if let Some(Value::Object(nested)) = opts.get("options") {
        nested.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    } else {
        opts
    }
}

/// Safely extracts a string value from a nested JSON path.
/// Returns an empty string if any key is not found or the final value is not a string.
pub fn get_string(json: &Value, path: &[&str]) -> String {
    let mut current = Some(json);
    for key in path {
        current = current.and_then(|c| c.get(key));
    }
    current.and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// Evaluates shell commands wrapped in backticks — `` `command` `` — replacing
/// each one with the command's stdout output, trimming the trailing newline.
///
/// Backticks were chosen as the only supported syntax because they read like
/// quotes and the user-facing explanation is simple: *write your command inside
/// backticks*, e.g. `` `date +%Y-%m-%d` ``.
///
/// If a command fails or cannot be run the original `` `command` `` token is
/// kept intact so the user sees what went wrong instead of a silent empty string.
///
/// On Unix this runs `sh -c "<cmd>"`. On Windows it runs `cmd /C "<cmd>"`.
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
        result.push_str(&run_shell_command(cmd).unwrap_or_else(|| format!("`{cmd}`")));
        remaining = &after_open[close + 1..];
    }

    result.push_str(remaining);
    result
}

fn run_shell_command(cmd: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    let output = std::process::Command::new("cmd")
        .args(["/C", cmd])
        .output()
        .ok()?;

    #[cfg(not(target_os = "windows"))]
    let output = std::process::Command::new("sh")
        .args(["-c", cmd])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Shells strip the trailing newline from $() — replicate that behaviour.
    Some(stdout.trim_end_matches(['\n', '\r']).to_string())
}

/// Recursively applies [`interpolate_shell_commands`] to every string inside a
/// JSON value, leaving non-string values unchanged.
pub fn interpolate_value(value: &Value) -> Value {
    match value {
        Value::String(s) => Value::String(interpolate_shell_commands(s)),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), interpolate_value(v)))
                .collect(),
        ),
        Value::Array(arr) => Value::Array(arr.iter().map(interpolate_value).collect()),
        _ => value.clone(),
    }
}

/// Utility to normalize Windows extended-length paths (e.g., //?/C:/path or \\?\C:\path) to C:/path, only on Windows
#[cfg(target_os = "windows")]
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
    #[cfg(not(target_os = "windows"))]
    fn test_date_expands() {
        let result = interpolate_shell_commands("backup_`date +%Y-%m-%d`");
        assert!(
            !result.contains('`'),
            "backtick should be replaced: {result}"
        );
        assert!(result.starts_with("backup_"));
        assert_eq!(result.len(), "backup_".len() + 10); // YYYY-MM-DD
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_multiple_expressions() {
        let result = interpolate_shell_commands("`date +%Y`/`date +%m`");
        assert!(
            !result.contains('`'),
            "all backticks should be replaced: {result}"
        );
        assert_eq!(result.len(), 7); // YYYY/MM
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_failing_command_left_intact() {
        let s = "prefix_`false`_suffix";
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
