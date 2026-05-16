pub const SENSITIVE_KEYS: &[&str] = &[
    "password",
    "pass",
    "session_id",
    "2fa",
    "secret",
    "endpoint",
    "token",
    "key",
    "credentials",
    "auth",
    "client_secret",
    "client_id",
    "api_key",
    "drive_id",
];

/// Check if a configuration key is considered sensitive.
#[must_use]
pub fn is_sensitive_field(key: &str) -> bool {
    let key = key.to_lowercase();
    SENSITIVE_KEYS.iter().any(|sk| key.contains(sk))
}
