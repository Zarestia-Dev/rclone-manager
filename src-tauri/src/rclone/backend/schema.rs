// Backend connection schema for settings UI

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, rcman::DeriveSettingsSchema)]
pub struct BackendConnectionSchema {
    #[setting(
        label = "Local Backend",
        description = "Whether this backend is managed locally by the application",
        input_type = "checkbox",
        group = "system",
        readonly = true
    )]
    pub is_local: bool,

    #[setting(
        label = "Host",
        description = "Hostname or IP address rclone binds to",
        placeholder = "e.g. 127.0.0.1 or my-nas.local",
        group = "connection",
        order = 10.0
    )]
    pub host: String,

    #[setting(
        label = "Port",
        min = 1.0,
        max = 65535.0,
        placeholder = "51900",
        group = "connection",
        order = 20.0
    )]
    pub port: u16,

    #[setting(
        label = "Username",
        placeholder = "Leave empty for no auth",
        group = "authentication",
        order = 30.0
    )]
    pub username: String,

    #[setting(
        label = "Password",
        secret,
        placeholder = "Leave empty for no auth",
        group = "authentication",
        order = 40.0
    )]
    pub password: String,

    #[setting(
        label = "OAuth Port",
        description = "Port the OAuth helper process listens on",
        min = 1.0,
        max = 65535.0,
        group = "oauth",
        order = 50.0
    )]
    pub oauth_port: u16,

    #[setting(
        label = "OAuth Host",
        description = "Host to connect to for OAuth callbacks. \
                       Must be a routable address — never a wildcard like 0.0.0.0. \
                       In Docker, set this to the container's accessible hostname.",
        placeholder = "127.0.0.1",
        group = "oauth",
        order = 51.0
    )]
    pub oauth_host: String,

    #[setting(
        label = "Config Password",
        secret,
        description = "Password for encrypted configuration file",
        group = "security",
        order = 60.0
    )]
    pub config_password: String,

    #[setting(
        label = "Config Path",
        description = "Specific path to rclone.conf (optional)",
        placeholder = "Leave empty to use default",
        group = "advanced",
        order = 70.0
    )]
    pub config_path: String,
}

impl Default for BackendConnectionSchema {
    fn default() -> Self {
        Self {
            is_local: true,
            host: "127.0.0.1".to_string(),
            port: 51900,
            username: String::new(),
            password: String::new(),
            oauth_port: 51901,
            oauth_host: "127.0.0.1".to_string(),
            config_password: String::new(),
            config_path: String::new(),
        }
    }
}
