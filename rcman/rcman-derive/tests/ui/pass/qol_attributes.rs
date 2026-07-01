use rcman::SettingsSchema;
use rcman_derive::SettingsSchema;
use serde::{Deserialize, Serialize};

#[derive(SettingsSchema, Default, Serialize, Deserialize)]
#[schema(category = "network")]
struct AdvancedSettings {
    #[setting(rename = "server-auth-port")]
    pub port: u16,

    #[setting(rename = "enable_tls")]
    pub tls: bool,

    #[setting(rename = "server-url")]
    pub url: String,

    pub roles: Vec<String>,
}

fn main() {
    let map = AdvancedSettings::get_metadata();

    // Prove it was renamed properly
    assert!(map.contains_key("network.server-auth-port"));
    assert!(map.contains_key("network.enable_tls"));
    assert!(map.contains_key("network.server-url"));
    assert!(map.contains_key("network.roles")); // no rename

    // Defaults come from Default::default() now
    assert_eq!(
        map.get("network.server-auth-port")
            .unwrap()
            .default
            .as_f64()
            .unwrap(),
        0.0
    );
    assert_eq!(
        map.get("network.enable_tls")
            .unwrap()
            .default
            .as_bool()
            .unwrap(),
        false
    );
    assert_eq!(
        map.get("network.server-url")
            .unwrap()
            .default
            .as_str()
            .unwrap(),
        ""
    );
}
