use serde_json::Value;
use std::collections::HashMap;

/// Safely converts a JSON object to a HashMap.
/// Returns None if the input is not a JSON object.
pub fn json_to_hashmap(json: Option<&Value>) -> Option<HashMap<String, Value>> {
    json.and_then(|v| v.as_object())
        .map(|obj| obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
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

/// Safely extracts a boolean value from a nested JSON path.
/// Returns the provided default value if any key is not found or the final value is not a boolean.
pub fn get_bool(json: &Value, path: &[&str], default: bool) -> bool {
    let mut current = Some(json);
    for key in path {
        current = current.and_then(|c| c.get(key));
    }
    current.and_then(|v| v.as_bool()).unwrap_or(default)
}
