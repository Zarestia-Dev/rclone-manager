use rcman_derive::SettingsSchema;
use serde::{Deserialize, Serialize};

#[derive(SettingsSchema, Default, Serialize, Deserialize)]
#[schema(category = "test")]
struct ValidationSettings {
    #[setting(min = 10, max = 5)]
    pub invalid_range: i32,

    #[setting(step = -1.0)]
    pub invalid_step: i32,

    #[setting(min = 10)]
    pub switch: bool, // min/max on bool

    #[setting(pattern = "regex")]
    pub switch2: bool, // pattern on bool

    #[setting(options(("a", "b")))]
    pub switch3: bool, // options on bool

    #[setting(pattern = "regex")]
    pub count: i32, // pattern on number

    #[setting(min = 10)]
    pub text: String, // min on text

    pub unknown_type: Option<std::time::Duration>, // Should error as unsupported type
}

fn main() {}
