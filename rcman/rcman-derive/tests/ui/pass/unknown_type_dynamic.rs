use rcman_derive::SettingsSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(SettingsSchema, Default, Serialize, Deserialize)]
#[schema(category = "test")]
struct UnknownTypeSettings {
    pub hash_map: HashMap<String, String>,
}

fn main() {}
