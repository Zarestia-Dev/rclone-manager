use rcman::SettingsSchema;
use rcman_derive::SettingsSchema;
use serde::{Deserialize, Serialize};

#[derive(SettingsSchema, Default, Serialize, Deserialize)]
#[schema(category = "test_cat")]
struct BasicSettings {
    #[setting(min = 1, max = 100)]
    pub port: u16,

    #[setting(pattern = "^[a-z]+$")]
    pub name: String,

    pub enabled: bool,
}

fn main() {
    let _map = BasicSettings::get_metadata();

    let mut settings = BasicSettings::default();
    let _ = settings.test_cat_port();
    let _ = settings.test_cat_name();
    let _ = settings.test_cat_enabled();
    settings.set_test_cat_port(42);
    settings.set_test_cat_name("demo".to_string());
    settings.set_test_cat_enabled(true);

    fn _assert_manager_trait<T: BasicSettingsManagerAccessors>(_manager: &T) {}
}
