//! Integration tests for rcman-derive macro
//!
//! Tests the `#[derive(DeriveSettingsSchema)]` macro with various attribute combinations.

use rcman::{DeriveSettingsSchema, SettingsManager, SettingsSchema};
use serde::{Deserialize, Serialize};

// =============================================================================
// Basic Derive Tests
// =============================================================================

#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
#[schema(category = "general")]
struct BasicSettings {
    #[setting(label = "Enable Feature")]
    enabled: bool,

    #[setting(label = "User Name", description = "The display name")]
    name: String,

    #[setting(label = "Max Count", min = 0, max = 100)]
    count: u32,
}

#[test]
fn test_basic_derive() {
    let metadata = BasicSettings::get_metadata();

    assert!(metadata.contains_key("general.enabled"));
    assert!(metadata.contains_key("general.name"));
    assert!(metadata.contains_key("general.count"));

    // Dynamic metadata support - labels and descriptions are now auto-added!
    let enabled = metadata.get("general.enabled").unwrap();
    assert_eq!(enabled.get_meta_str("label"), Some("Enable Feature"));

    let name = metadata.get("general.name").unwrap();
    assert_eq!(name.get_meta_str("label"), Some("User Name"));
    assert_eq!(name.get_meta_str("description"), Some("The display name"));

    // Check min/max using constraints - these ARE handled by derive macro
    let count = metadata.get("general.count").unwrap();
    assert_eq!(count.get_meta_str("label"), Some("Max Count"));
    assert_eq!(count.constraints.number.min, Some(0.0));
    assert_eq!(count.constraints.number.max, Some(100.0));
}

// =============================================================================
// Nested Struct Tests
// =============================================================================

#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
#[schema(category = "ui")]
struct UiSettings {
    #[setting(label = "Theme")]
    theme: String,

    #[setting(label = "Dark Mode")]
    dark_mode: bool,
}

#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
struct AppSettings {
    ui: UiSettings,

    #[setting(label = "Language", category = "general")]
    language: String,
}

#[test]
fn test_nested_structs() {
    let metadata = AppSettings::get_metadata();

    // Nested ui settings should have "ui." prefix
    assert!(metadata.contains_key("ui.theme"));
    assert!(metadata.contains_key("ui.dark_mode"));

    // Top-level setting with explicit category
    assert!(metadata.contains_key("general.language"));
}

// =============================================================================
// Select Options Tests
// =============================================================================

#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
#[schema(category = "config")]
struct SelectSettings {
    #[setting(
        label = "Log Level",
        options(("debug", "Debug"), ("info", "Info"), ("error", "Error"))
    )]
    log_level: String,
}

#[test]
fn test_select_options() {
    let metadata = SelectSettings::get_metadata();

    let log_level = metadata.get("config.log_level").unwrap();
    assert!(log_level.constraints.options.is_some());

    let options = log_level.constraints.options.as_ref().unwrap();
    assert_eq!(options.len(), 3);
    assert_eq!(options[0].value, "debug");
    assert_eq!(options[0].label, "Debug");
}

// =============================================================================
// Skip Field Tests
// =============================================================================

#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
#[schema(category = "test")]
struct SkipSettings {
    #[setting(label = "Visible")]
    visible: bool,

    #[setting(skip)]
    internal_state: u32,
}

#[test]
fn test_skip_field() {
    let metadata = SkipSettings::get_metadata();

    assert!(metadata.contains_key("test.visible"));
    assert!(!metadata.contains_key("test.internal_state"));
}

// =============================================================================
// Auto-Generated Labels Tests
// =============================================================================

#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
#[schema(category = "auto")]
struct AutoLabelSettings {
    // No label attribute - should auto-generate from field name
    enable_notifications: bool,
    max_retry_count: u32,
}

#[test]
fn test_auto_generated_labels() {
    let metadata = AutoLabelSettings::get_metadata();

    let notifications = metadata.get("auto.enable_notifications").unwrap();
    // Label should be None if not provided
    assert_eq!(notifications.get_meta_str("label"), None);

    let retry = metadata.get("auto.max_retry_count").unwrap();
    // Label should be None if not provided
    assert_eq!(retry.get_meta_str("label"), None);
}

// =============================================================================
// Type Detection Tests
// =============================================================================

#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
#[schema(category = "types")]
struct TypeSettings {
    flag: bool,
    text: String,
    small_int: i16,
    big_int: u64,
    decimal: f64,
    tags: Vec<String>,
}

#[test]
fn test_type_detection() {
    let metadata = TypeSettings::get_metadata();

    // All fields should be detected with correct types
    assert!(metadata.contains_key("types.flag"));
    assert!(metadata.contains_key("types.text"));
    assert!(metadata.contains_key("types.small_int"));
    assert!(metadata.contains_key("types.big_int"));
    assert!(metadata.contains_key("types.decimal"));
    assert!(metadata.contains_key("types.tags"));
}

// Test explicit nested attribute
#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
#[schema(category = "sub")]
struct SubConfig {
    value: String,
}

#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
#[schema(category = "main")]
struct ExplicitNestedTest {
    #[setting(nested)]
    sub: SubConfig,
    normal: String,
}

#[test]
fn test_explicit_nested() {
    let m = ExplicitNestedTest::get_metadata();
    assert!(m.contains_key("sub.value"));
    assert!(m.contains_key("main.normal"));
}

#[test]
fn test_metadata_attributes() {
    use rcman::{DeriveSettingsSchema, SettingsSchema};
    use serde::{Deserialize, Serialize};

    #[derive(DeriveSettingsSchema, Default, Serialize, Deserialize)]
    #[schema(category = "server")]
    struct ServerSettings {
        #[setting(
            min = 1024,
            max = 65535,
            label = "API Port",
            description = "Port number for the API server",
            order = 1,
            advanced = false,
            requires_restart = true
        )]
        port: u16,

        #[setting(
            label = "Debug Mode",
            help = "Enable verbose logging",
            order = 2,
            advanced = true
        )]
        debug: bool,

        #[setting(
            label = "Server Name",
            description = "Human-readable server name",
            priority = 10,
            readonly = false
        )]
        name: String,
    }

    let metadata = ServerSettings::get_metadata();

    // Test port metadata
    let port = metadata.get("server.port").unwrap();
    assert_eq!(port.get_meta_str("label"), Some("API Port"));
    assert_eq!(
        port.get_meta_str("description"),
        Some("Port number for the API server")
    );
    assert_eq!(port.get_meta_num("order"), Some(1.0));
    assert_eq!(port.get_meta_bool("advanced"), Some(false));
    assert_eq!(port.get_meta_bool("requires_restart"), Some(true));
    assert_eq!(port.constraints.number.min, Some(1024.0));
    assert_eq!(port.constraints.number.max, Some(65535.0));

    // Test debug metadata
    let debug = metadata.get("server.debug").unwrap();
    assert_eq!(debug.get_meta_str("label"), Some("Debug Mode"));
    assert_eq!(debug.get_meta_str("help"), Some("Enable verbose logging"));
    assert_eq!(debug.get_meta_num("order"), Some(2.0));
    assert_eq!(debug.get_meta_bool("advanced"), Some(true));
    assert_eq!(debug.get_meta_bool("requires_restart"), None);

    // Test name metadata
    let name = metadata.get("server.name").unwrap();
    assert_eq!(name.get_meta_str("label"), Some("Server Name"));
    assert_eq!(
        name.get_meta_str("description"),
        Some("Human-readable server name")
    );
    assert_eq!(name.get_meta_num("priority"), Some(10.0));
    assert_eq!(name.get_meta_bool("readonly"), Some(false));
}

// =============================================================================
// Dynamic Metadata Tests
// =============================================================================

#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
#[schema(category = "advanced")]
struct DynamicMetadataSettings {
    #[setting(
        min = 1024,
        max = 65535,
        label = "Server Port",
        description = "Port for the API server",
        order = 1,
        advanced = false,
        requires_restart = true,
        my_custom_field = "custom value"
    )]
    port: u16,

    #[setting(label = "Enable Logging", order = 2, advanced = true)]
    logging: bool,

    #[setting(
        label = "Timeout",
        description = "Request timeout in seconds",
        min = 1.0,
        max = 300.0,
        step = 0.5,
        priority = 5.5
    )]
    timeout: f64,
}

#[test]
fn test_dynamic_metadata() {
    let metadata = DynamicMetadataSettings::get_metadata();

    // Test port field with multiple metadata types
    let port = metadata.get("advanced.port").unwrap();
    assert_eq!(port.get_meta_str("label"), Some("Server Port"));
    assert_eq!(
        port.get_meta_str("description"),
        Some("Port for the API server")
    );
    assert_eq!(port.get_meta_str("my_custom_field"), Some("custom value"));
    assert_eq!(port.get_meta_num("order"), Some(1.0));
    assert_eq!(port.get_meta_bool("advanced"), Some(false));
    assert_eq!(port.get_meta_bool("requires_restart"), Some(true));
    assert_eq!(port.constraints.number.min, Some(1024.0));
    assert_eq!(port.constraints.number.max, Some(65535.0));

    // Test logging field
    let logging = metadata.get("advanced.logging").unwrap();
    assert_eq!(logging.get_meta_str("label"), Some("Enable Logging"));
    assert_eq!(logging.get_meta_num("order"), Some(2.0));
    assert_eq!(logging.get_meta_bool("advanced"), Some(true));

    // Test timeout field with float metadata
    let timeout = metadata.get("advanced.timeout").unwrap();
    assert_eq!(timeout.get_meta_str("label"), Some("Timeout"));
    assert_eq!(
        timeout.get_meta_str("description"),
        Some("Request timeout in seconds")
    );
    assert_eq!(timeout.get_meta_num("priority"), Some(5.5));
    assert_eq!(timeout.constraints.number.min, Some(1.0));
    assert_eq!(timeout.constraints.number.max, Some(300.0));
    assert_eq!(timeout.constraints.number.step, Some(0.5));
}

#[test]
fn test_pattern_constraint() {
    use rcman::{DeriveSettingsSchema, SettingsSchema};
    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    #[derive(DeriveSettingsSchema, Default, Serialize, Deserialize)]
    #[schema(category = "validation")]
    struct ValidationSettings {
        #[setting(pattern = r"^[\w.-]+@[\w.-]+\.\w+$", label = "Email Address")]
        email: String,

        #[setting(pattern = r"^\d{3}-\d{3}-\d{4}$", label = "Phone Number")]
        phone: String,
    }

    let metadata = ValidationSettings::get_metadata();

    // Test email pattern constraint
    let email = metadata.get("validation.email").unwrap();
    assert_eq!(
        email.constraints.text.pattern,
        Some(r"^[\w.-]+@[\w.-]+\.\w+$".to_string())
    );
    assert_eq!(email.get_meta_str("label"), Some("Email Address"));

    // Test validation with email pattern
    assert!(
        email
            .validate(&Value::String("user@example.com".to_string()))
            .is_ok()
    );
    assert!(
        email
            .validate(&Value::String("invalid-email".to_string()))
            .is_err()
    );

    // Test phone pattern constraint
    let phone = metadata.get("validation.phone").unwrap();
    assert_eq!(
        phone.constraints.text.pattern,
        Some(r"^\d{3}-\d{3}-\d{4}$".to_string())
    );
    assert_eq!(phone.get_meta_str("label"), Some("Phone Number"));

    // Test validation with phone pattern
    assert!(
        phone
            .validate(&Value::String("123-456-7890".to_string()))
            .is_ok()
    );
    assert!(
        phone
            .validate(&Value::String("1234567890".to_string()))
            .is_err()
    );
}

// =============================================================================
// Fully Qualified Path Tests
// =============================================================================

#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
#[schema(category = "fqn")]
struct FullyQualifiedSettings {
    #[setting(label = "List of Tags")]
    tags: std::vec::Vec<std::string::String>,

    #[setting(label = "Resource Path")]
    path: std::string::String,
}

#[test]
fn test_fully_qualified_paths() {
    let metadata = FullyQualifiedSettings::get_metadata();

    // Test Vec properly resolved via FQN
    let tags = metadata.get("fqn.tags").unwrap();
    assert_eq!(tags.get_meta_str("label"), Some("List of Tags"));
    assert_eq!(tags.setting_type, rcman::SettingType::List);

    // Test String properly resolved via FQN
    let path = metadata.get("fqn.path").unwrap();
    assert_eq!(path.get_meta_str("label"), Some("Resource Path"));
    assert_eq!(path.setting_type, rcman::SettingType::Text);
}

// =============================================================================
// Type-Safe Accessor Tests
// =============================================================================

#[test]
fn test_snapshot_accessors() {
    let mut settings = BasicSettings {
        enabled: false,
        name: "Alice".to_string(),
        count: 3,
    };

    assert!(!*settings.general_enabled());
    assert_eq!(settings.general_name(), "Alice");
    assert_eq!(*settings.general_count(), 3);

    settings.set_general_enabled(true);
    settings.set_general_name("Bob".to_string());
    settings.set_general_count(9);

    assert!(*settings.general_enabled());
    assert_eq!(settings.general_name(), "Bob");
    assert_eq!(*settings.general_count(), 9);
}

#[test]
fn test_manager_accessors() {
    let temp = tempfile::tempdir().unwrap();

    let manager = SettingsManager::builder("derive-accessor-test", "1.0.0")
        .with_config_dir(temp.path())
        .with_schema::<BasicSettings>()
        .build()
        .unwrap();

    // Typed setters/getters
    manager.set_general_enabled(true).unwrap();
    manager.set_general_name("Charlie".to_string()).unwrap();
    manager.set_general_count(12).unwrap();

    assert!(manager.general_enabled().unwrap());
    assert_eq!(manager.general_name().unwrap(), "Charlie");
    assert_eq!(manager.general_count().unwrap(), 12);

    // String API remains available and in parity
    let enabled: bool = manager.get("general.enabled").unwrap();
    let name: String = manager.get("general.name").unwrap();
    let count: u32 = manager.get("general.count").unwrap();

    assert!(enabled);
    assert_eq!(name, "Charlie");
    assert_eq!(count, 12);
}

#[derive(Default, Serialize, Deserialize, DeriveSettingsSchema)]
#[schema(category = "ui")]
struct RenamedAccessorSettings {
    #[setting(rename = "theme-name")]
    theme: String,
}

#[test]
fn test_renamed_field_accessor() {
    let temp = tempfile::tempdir().unwrap();

    let manager = SettingsManager::builder("derive-accessor-rename-test", "1.0.0")
        .with_config_dir(temp.path())
        .with_schema::<RenamedAccessorSettings>()
        .build()
        .unwrap();

    manager.set_ui_theme("light".to_string()).unwrap();
    assert_eq!(manager.ui_theme().unwrap(), "light");

    // String API reads the renamed key path and remains compatible.
    let theme: String = manager.get("ui.theme-name").unwrap();
    assert_eq!(theme, "light");
}
