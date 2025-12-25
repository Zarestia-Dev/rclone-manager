// GUI Demo for rcman - Interactive Settings Panel
//
// Run with: cargo run --example gui_demo
// With keychain: cargo run --example gui_demo --features keychain
//
// This example demonstrates how rcman works visually:
// - Loading settings from schema
// - Editing settings with appropriate controls
// - Validation feedback
// - Default value behavior (reset removes from storage)
// - Secret settings (stored in keychain)
// - Backup & Restore (encrypted and normal)
// - Real-time save/load

use eframe::egui;
use rcman::{
    opt, settings, BackupOptions, RestoreOptions, SettingMetadata, SettingsConfig, SettingsManager,
    SettingsSchema, SubSettingsConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

// ============================================================================
// SETTINGS SCHEMA - Define your settings here
// ============================================================================

#[derive(Default, Serialize, Deserialize, Clone)]
struct DemoSettings;

impl SettingsSchema for DemoSettings {
    fn get_metadata() -> HashMap<String, SettingMetadata> {
        settings! {
            // App settings
            "app.name" => SettingMetadata::text("App Name", "My App")
                .description("Application name")
                .category("General")
                .order(1),

            "app.theme" => SettingMetadata::select("Theme", "light", vec![
                opt("light", "☀️ Light"),
                opt("dark", "🌙 Dark"),
                opt("auto", "🔄 Auto"),
            ])
                .description("Application color theme")
                .category("Appearance")
                .order(2),

            "app.font_size" => SettingMetadata::number("Font Size", 14.0)
                .description("Base font size in pixels")
                .min(8.0)
                .max(32.0)
                .step(1.0)
                .category("Appearance")
                .order(3),

            "app.animations" => SettingMetadata::toggle("Enable Animations", true)
                .description("Show smooth animations and transitions")
                .category("Appearance")
                .order(4),

            // Network settings
            "network.timeout" => SettingMetadata::number("Timeout (seconds)", 30.0)
                .description("Network request timeout")
                .min(5.0)
                .max(300.0)
                .step(5.0)
                .category("Network")
                .order(1),

            "network.retries" => SettingMetadata::number("Max Retries", 3.0)
                .description("Number of retry attempts on failure")
                .min(0.0)
                .max(10.0)
                .step(1.0)
                .category("Network")
                .order(2),

            // User settings (with validation)
            "user.email" => SettingMetadata::text("Email", "")
                .description("Your email address")
                .pattern(r"^$|^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$")
                .pattern_error("Please enter a valid email address")
                .placeholder("user@example.com")
                .category("User")
                .order(1),

            "user.username" => SettingMetadata::text("Username", "")
                .description("3-20 alphanumeric characters")
                .pattern(r"^$|^[a-zA-Z0-9_]{3,20}$")
                .pattern_error("Username must be 3-20 alphanumeric characters")
                .category("User")
                .order(2),

            // Secret settings (stored in keychain when feature enabled)
            "secrets.api_key" => SettingMetadata::password("API Key", "")
                .description("Your API key (stored in keychain)")
                .category("Secrets")
                .secret()
                .order(1),

            "secrets.db_password" => SettingMetadata::password("Database Password", "")
                .description("Database password (stored in keychain)")
                .category("Secrets")
                .secret()
                .order(2),

            // Advanced settings
            "advanced.debug" => SettingMetadata::toggle("Debug Mode", false)
                .description("Enable verbose logging")
                .category("Advanced")
                .advanced(),
        }
    }
}

// ============================================================================
// GUI APPLICATION
// ============================================================================

struct DemoApp {
    manager: Arc<SettingsManager>,

    keychain_enabled: bool,
    encrypted_backend_status: String,

    // Current values (editable)
    app_name: String,
    theme: String,
    font_size: f32,
    animations: bool,
    timeout: f32,
    retries: f32,
    email: String,
    username: String,
    api_key: String,
    db_password: String,
    debug: bool,

    // UI state
    status_message: String,
    show_json: bool,
    current_json: String,
    show_api_key: bool,
    show_db_password: bool,

    // Backup state
    backup_password: String,
    backup_note: String,
    use_encryption: bool,
    last_backup_path: Option<PathBuf>,
    backup_list: Vec<PathBuf>,
    selected_backup_index: Option<usize>,
    restore_password: String,
    restore_requires_password: bool,
    backup_analysis: Option<String>,

    // Sub-settings state (remotes demo)
    remotes_list: Vec<String>,
    new_remote_name: String,
    new_remote_type: String,
    selected_remote: Option<String>,
    selected_remote_data: String,
}

impl DemoApp {
    fn new(_cc: &eframe::CreationContext<'_>) -> Self {
        // Create runtime for async operations

        // Check if keychain feature is available
        let keychain_enabled = cfg!(feature = "keychain");

        // Detect encrypted backend status
        let encrypted_backend_status = if cfg!(feature = "encrypted-file") {
            let path = std::path::Path::new("./example_config/credentials.enc.json");
            if path.exists() {
                format!("Active (Argon2id v3)\nPath: {}", path.display())
            } else {
                "Enabled (Argon2id v3) - Waiting for secrets".to_string()
            }
        } else {
            "Disabled (enable 'encrypted-file' feature)".to_string()
        };

        // Initialize settings manager
        let config_builder =
            SettingsConfig::builder("rcman-gui-demo", "1.0.0").config_dir("./example_config");

        // Enable credentials if keychain feature is available
        #[cfg(feature = "keychain")]
        let config = config_builder.with_credentials().build();
        #[cfg(not(feature = "keychain"))]
        let config = config_builder.build();

        let manager = Arc::new(SettingsManager::new(config).expect("Failed to create manager"));

        // Load initial settings
        let settings = { manager.load_settings::<DemoSettings>().unwrap_or_default() };

        // Extract values from loaded settings (SettingMetadata has a `value` field)
        let get_value = |key: &str| -> Value {
            settings
                .get(key)
                .and_then(|m| m.value.clone())
                .unwrap_or(Value::Null)
        };

        // Scan for existing backups
        let backup_list = Self::scan_backups();

        // Register sub-settings for remotes and load list
        let manager_clone = manager.clone();
        let remotes_list = {
            manager_clone.register_sub_settings(SubSettingsConfig::new("remotes"));

            // Load remotes list
            match manager_clone.sub_settings("remotes") {
                Ok(sub) => sub.list().unwrap_or_default(),
                Err(_) => Vec::new(),
            }
        };

        Self {
            manager,

            keychain_enabled,
            encrypted_backend_status,
            app_name: get_value("app.name")
                .as_str()
                .unwrap_or("My App")
                .to_string(),
            theme: get_value("app.theme")
                .as_str()
                .unwrap_or("light")
                .to_string(),
            font_size: get_value("app.font_size").as_f64().unwrap_or(14.0) as f32,
            animations: get_value("app.animations").as_bool().unwrap_or(true),
            timeout: get_value("network.timeout").as_f64().unwrap_or(30.0) as f32,
            retries: get_value("network.retries").as_f64().unwrap_or(3.0) as f32,
            email: get_value("user.email").as_str().unwrap_or("").to_string(),
            username: get_value("user.username")
                .as_str()
                .unwrap_or("")
                .to_string(),
            api_key: get_value("secrets.api_key")
                .as_str()
                .unwrap_or("")
                .to_string(),
            db_password: get_value("secrets.db_password")
                .as_str()
                .unwrap_or("")
                .to_string(),
            debug: get_value("advanced.debug").as_bool().unwrap_or(false),
            status_message: "✅ Settings loaded".to_string(),
            show_json: false,
            current_json: String::new(),
            show_api_key: false,
            show_db_password: false,
            // Backup state
            backup_password: String::new(),
            backup_note: String::new(),
            use_encryption: false,
            last_backup_path: None,
            backup_list,
            selected_backup_index: None,
            restore_password: String::new(),
            restore_requires_password: false,
            backup_analysis: None,
            // Sub-settings state
            remotes_list,
            new_remote_name: String::new(),
            new_remote_type: "drive".to_string(),
            selected_remote: None,
            selected_remote_data: String::new(),
        }
    }

    fn scan_backups() -> Vec<PathBuf> {
        let backup_dir = PathBuf::from("./example_config/backups");
        if !backup_dir.exists() {
            return Vec::new();
        }
        std::fs::read_dir(&backup_dir)
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().map(|e| e == "rcman").unwrap_or(false))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn create_backup(&mut self) {
        let manager = self.manager.clone();
        let password = if self.use_encryption && !self.backup_password.is_empty() {
            Some(self.backup_password.clone())
        } else {
            None
        };
        let note = if self.backup_note.is_empty() {
            None
        } else {
            Some(self.backup_note.clone())
        };

        match {
            let mut options = BackupOptions::new().output_dir("./example_config/backups");
            if let Some(pw) = password {
                options = options.password(pw);
            }
            if let Some(n) = note {
                options = options.note(n);
            }
            manager.backup().create(options)
        } {
            Ok(path) => {
                let encrypted = if self.use_encryption && !self.backup_password.is_empty() {
                    " (encrypted)"
                } else {
                    ""
                };
                self.status_message = format!(
                    "📦 Backup created{}: {:?}",
                    encrypted,
                    path.file_name().unwrap_or_default()
                );
                self.last_backup_path = Some(path);
                self.backup_list = Self::scan_backups();
            }
            Err(e) => {
                self.status_message = format!("❌ Backup failed: {}", e);
            }
        }
    }

    fn restore_backup(&mut self) {
        let Some(index) = self.selected_backup_index else {
            self.status_message = "❌ No backup selected".to_string();
            return;
        };
        let Some(backup_path) = self.backup_list.get(index).cloned() else {
            self.status_message = "❌ Invalid backup selection".to_string();
            return;
        };

        let manager = self.manager.clone();
        let password = if !self.restore_password.is_empty() {
            Some(self.restore_password.clone())
        } else {
            None
        };

        match {
            let mut options = RestoreOptions::from_path(&backup_path)
                .overwrite(true)
                .verify_checksum(true);
            if let Some(pw) = password {
                options = options.password(pw);
            }
            manager.backup().restore(options)
        } {
            Ok(_) => {
                self.status_message = "✅ Backup restored successfully!".to_string();
                self.reload_settings();
            }
            Err(e) => {
                self.status_message = format!("❌ Restore failed: {}", e);
            }
        }
    }

    fn analyze_backup(&mut self) {
        let Some(index) = self.selected_backup_index else {
            self.status_message = "❌ No backup selected".to_string();
            return;
        };
        let Some(backup_path) = self.backup_list.get(index).cloned() else {
            self.status_message = "❌ Invalid backup selection".to_string();
            return;
        };

        let manager = self.manager.clone();
        match manager.backup().analyze(&backup_path) {
            Ok(analysis) => {
                let info = format!(
                    "📋 Backup Analysis:\n\
                     ├─ Valid: {}\n\
                     ├─ Encrypted: {}\n\
                     ├─ App Version: {}\n\
                     ├─ Manifest Version: {}\n\
                     └─ Warnings: {}",
                    if analysis.is_valid {
                        "✅ Yes"
                    } else {
                        "❌ No"
                    },
                    if analysis.requires_password {
                        "🔒 Yes"
                    } else {
                        "🔓 No"
                    },
                    analysis.manifest.backup.app_version,
                    analysis.manifest.version,
                    if analysis.warnings.is_empty() {
                        "None".to_string()
                    } else {
                        analysis.warnings.join(", ")
                    }
                );
                self.backup_analysis = Some(info);
                self.restore_requires_password = analysis.requires_password;
                self.status_message = "✅ Backup analyzed".to_string();
            }
            Err(e) => {
                self.backup_analysis = None;
                self.restore_requires_password = false;
                self.status_message = format!("❌ Analysis failed: {}", e);
            }
        }
    }

    fn refresh_remotes(&mut self) {
        let manager = self.manager.clone();
        match (|| -> rcman::Result<_> {
            let sub = manager.sub_settings("remotes")?;
            sub.list()
        })() {
            Ok(list) => {
                self.remotes_list = list;
                self.status_message = format!("📂 Found {} remotes", self.remotes_list.len());
            }
            Err(e) => {
                self.status_message = format!("❌ Failed to load remotes: {}", e);
            }
        }
    }

    fn add_remote(&mut self) {
        if self.new_remote_name.is_empty() {
            self.status_message = "❌ Remote name cannot be empty".to_string();
            return;
        }

        let manager = self.manager.clone();
        let name = self.new_remote_name.clone();
        let remote_type = self.new_remote_type.clone();

        match (|| -> rcman::Result<_> {
            let sub = manager.sub_settings("remotes")?;
            sub.set(
                &name,
                &json!({
                    "type": remote_type
                }),
            )
        })() {
            Ok(_) => {
                self.status_message = format!("✅ Added remote: {}", self.new_remote_name);
                self.new_remote_name.clear();
                self.refresh_remotes();
            }
            Err(e) => {
                self.status_message = format!("❌ Failed to add remote: {}", e);
            }
        }
    }

    fn delete_remote(&mut self, name: &str) {
        let manager = self.manager.clone();
        let remote_name = name.to_string();

        match (|| -> rcman::Result<_> {
            let sub = manager.sub_settings("remotes")?;
            sub.delete(&remote_name)
        })() {
            Ok(_) => {
                self.status_message = format!("🗑️ Deleted remote: {}", name);
                self.selected_remote = None;
                self.selected_remote_data.clear();
                self.refresh_remotes();
            }
            Err(e) => {
                self.status_message = format!("❌ Failed to delete remote: {}", e);
            }
        }
    }

    fn load_remote_data(&mut self, name: &str) {
        let manager = self.manager.clone();
        let remote_name = name.to_string();

        match (|| -> rcman::Result<_> {
            let sub = manager.sub_settings("remotes")?;
            sub.get::<Value>(&remote_name)
        })() {
            Ok(data) => {
                self.selected_remote_data = serde_json::to_string_pretty(&data).unwrap_or_default();
            }
            Err(e) => {
                self.selected_remote_data = format!("Error: {}", e);
            }
        }
    }

    fn save_setting(&mut self, category: &str, key: &str, value: Value) {
        let manager = self.manager.clone();
        match { manager.save_setting::<DemoSettings>(category, key, value) } {
            Ok(_) => {
                self.status_message = format!("✅ Saved {}.{}", category, key);
            }
            Err(e) => {
                self.status_message = format!("❌ Error: {}", e);
            }
        }
        self.update_json_view();
    }

    fn reset_setting(&mut self, category: &str, key: &str) {
        let manager = self.manager.clone();
        match { manager.reset_setting::<DemoSettings>(category, key) } {
            Ok(default_value) => {
                self.status_message = format!(
                    "🔄 Reset {}.{} to default: {}",
                    category, key, default_value
                );
            }
            Err(e) => {
                self.status_message = format!("❌ Error: {}", e);
            }
        }
        self.reload_settings();
    }

    fn reload_settings(&mut self) {
        let manager = self.manager.clone();
        let settings = { manager.load_settings::<DemoSettings>().unwrap_or_default() };

        let get_value = |key: &str| -> Value {
            settings
                .get(key)
                .and_then(|m| m.value.clone())
                .unwrap_or(Value::Null)
        };

        self.app_name = get_value("app.name")
            .as_str()
            .unwrap_or("My App")
            .to_string();
        self.theme = get_value("app.theme")
            .as_str()
            .unwrap_or("light")
            .to_string();
        self.font_size = get_value("app.font_size").as_f64().unwrap_or(14.0) as f32;
        self.animations = get_value("app.animations").as_bool().unwrap_or(true);
        self.timeout = get_value("network.timeout").as_f64().unwrap_or(30.0) as f32;
        self.retries = get_value("network.retries").as_f64().unwrap_or(3.0) as f32;
        self.email = get_value("user.email").as_str().unwrap_or("").to_string();
        self.username = get_value("user.username")
            .as_str()
            .unwrap_or("")
            .to_string();
        self.api_key = get_value("secrets.api_key")
            .as_str()
            .unwrap_or("")
            .to_string();
        self.db_password = get_value("secrets.db_password")
            .as_str()
            .unwrap_or("")
            .to_string();
        self.debug = get_value("advanced.debug").as_bool().unwrap_or(false);

        self.update_json_view();
    }

    fn update_json_view(&mut self) {
        let path = self.manager.config().settings_path();
        self.current_json = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".to_string());
    }
}

impl eframe::App for DemoApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Apply theme
        if self.theme == "dark" {
            ctx.set_visuals(egui::Visuals::dark());
        } else {
            ctx.set_visuals(egui::Visuals::light());
        }

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("🔧 rcman GUI Demo");
            ui.label("Interactive demonstration of the rcman settings library");

            // Keychain status
            if self.keychain_enabled {
                ui.label(
                    egui::RichText::new("🔐 Keychain: Enabled")
                        .color(egui::Color32::GREEN)
                        .small(),
                );
            } else {
                ui.label(
                    egui::RichText::new("🔒 Keychain: Disabled (run with --features keychain)")
                        .color(egui::Color32::YELLOW)
                        .small(),
                );
            }

            ui.add_space(4.0);
            ui.label(
                egui::RichText::new(format!(
                    "🗄️ Encrypted File: {}",
                    self.encrypted_backend_status
                ))
                .small(),
            );

            ui.separator();

            // Status bar
            ui.horizontal(|ui| {
                ui.label(&self.status_message);
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("🔄 Reload").clicked() {
                        self.reload_settings();
                        self.status_message = "✅ Settings reloaded".to_string();
                    }
                    ui.checkbox(&mut self.show_json, "📄 Show JSON");
                });
            });
            ui.separator();

            egui::ScrollArea::vertical().show(ui, |ui| {
                // ================================================================
                // APP SECTION
                // ================================================================
                ui.collapsing("📱 App Settings", |ui| {
                    ui.horizontal(|ui| {
                        ui.label("App Name:");
                        let response = ui.text_edit_singleline(&mut self.app_name);
                        if response.lost_focus() {
                            self.save_setting("app", "name", json!(self.app_name));
                        }
                        if ui
                            .small_button("↩")
                            .on_hover_text("Reset to default")
                            .clicked()
                        {
                            self.reset_setting("app", "name");
                        }
                    });
                    ui.add_space(4.0);

                    ui.horizontal(|ui| {
                        ui.label("Theme:");
                        let old_theme = self.theme.clone();
                        egui::ComboBox::from_id_salt("theme")
                            .selected_text(match self.theme.as_str() {
                                "light" => "☀️ Light",
                                "dark" => "🌙 Dark",
                                "auto" => "🔄 Auto",
                                _ => "Unknown",
                            })
                            .show_ui(ui, |ui| {
                                ui.selectable_value(
                                    &mut self.theme,
                                    "light".to_string(),
                                    "☀️ Light",
                                );
                                ui.selectable_value(&mut self.theme, "dark".to_string(), "🌙 Dark");
                                ui.selectable_value(&mut self.theme, "auto".to_string(), "🔄 Auto");
                            });
                        if self.theme != old_theme {
                            self.save_setting("app", "theme", json!(self.theme));
                        }
                        if ui.small_button("↩").clicked() {
                            self.reset_setting("app", "theme");
                        }
                    });
                    ui.add_space(4.0);

                    ui.horizontal(|ui| {
                        ui.label("Font Size:");
                        let old_size = self.font_size;
                        ui.add(egui::Slider::new(&mut self.font_size, 8.0..=32.0).suffix("px"));
                        if (self.font_size - old_size).abs() > 0.1 {
                            self.save_setting("app", "font_size", json!(self.font_size as f64));
                        }
                        if ui.small_button("↩").clicked() {
                            self.reset_setting("app", "font_size");
                        }
                    });
                    ui.add_space(4.0);

                    ui.horizontal(|ui| {
                        let old_anim = self.animations;
                        ui.checkbox(&mut self.animations, "Enable Animations");
                        if self.animations != old_anim {
                            self.save_setting("app", "animations", json!(self.animations));
                        }
                        if ui.small_button("↩").clicked() {
                            self.reset_setting("app", "animations");
                        }
                    });
                });

                ui.add_space(8.0);

                // ================================================================
                // NETWORK SECTION
                // ================================================================
                ui.collapsing("🌐 Network", |ui| {
                    ui.horizontal(|ui| {
                        ui.label("Timeout:");
                        let old_timeout = self.timeout;
                        ui.add(egui::Slider::new(&mut self.timeout, 5.0..=300.0).suffix(" sec"));
                        if (self.timeout - old_timeout).abs() > 0.1 {
                            self.save_setting("network", "timeout", json!(self.timeout as f64));
                        }
                        if ui.small_button("↩").clicked() {
                            self.reset_setting("network", "timeout");
                        }
                    });
                    ui.add_space(4.0);

                    ui.horizontal(|ui| {
                        ui.label("Max Retries:");
                        let old_retries = self.retries;
                        ui.add(egui::Slider::new(&mut self.retries, 0.0..=10.0).step_by(1.0));
                        if (self.retries - old_retries).abs() > 0.1 {
                            self.save_setting("network", "retries", json!(self.retries as f64));
                        }
                        if ui.small_button("↩").clicked() {
                            self.reset_setting("network", "retries");
                        }
                    });
                });

                ui.add_space(8.0);

                // ================================================================
                // USER SECTION (with validation)
                // ================================================================
                ui.collapsing("👤 User (Validation Demo)", |ui| {
                    ui.label("These fields have regex validation:");
                    ui.add_space(4.0);

                    ui.horizontal(|ui| {
                        ui.label("Email:");
                        let response = ui.text_edit_singleline(&mut self.email);
                        if response.lost_focus() {
                            self.save_setting("user", "email", json!(self.email));
                        }
                        if ui.small_button("↩").clicked() {
                            self.reset_setting("user", "email");
                        }
                    });
                    ui.add_space(4.0);

                    ui.horizontal(|ui| {
                        ui.label("Username:");
                        let response = ui.text_edit_singleline(&mut self.username);
                        if response.lost_focus() {
                            self.save_setting("user", "username", json!(self.username));
                        }
                        if ui.small_button("↩").clicked() {
                            self.reset_setting("user", "username");
                        }
                    });

                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new("💡 Try invalid values to see validation errors!")
                            .small()
                            .weak(),
                    );
                });

                ui.add_space(8.0);

                // ================================================================
                // SECRETS SECTION (keychain)
                // ================================================================
                ui.collapsing("🔐 Secrets (Keychain Demo)", |ui| {
                    if self.keychain_enabled {
                        ui.label(
                            egui::RichText::new(
                                "Secrets are stored in your OS keychain, NOT in settings.json!",
                            )
                            .color(egui::Color32::GREEN)
                            .small(),
                        );
                    } else {
                        ui.label(
                            egui::RichText::new(
                                "⚠️ Run with --features keychain to enable secure storage",
                            )
                            .color(egui::Color32::YELLOW)
                            .small(),
                        );
                    }
                    ui.add_space(4.0);

                    ui.horizontal(|ui| {
                        ui.label("API Key:");
                        if self.show_api_key {
                            let response = ui.text_edit_singleline(&mut self.api_key);
                            if response.lost_focus() {
                                self.save_setting("secrets", "api_key", json!(self.api_key));
                            }
                        } else {
                            ui.label(if self.api_key.is_empty() {
                                "(empty)"
                            } else {
                                "••••••••"
                            });
                        }
                        if ui
                            .small_button(if self.show_api_key {
                                "👁"
                            } else {
                                "👁‍🗨"
                            })
                            .clicked()
                        {
                            self.show_api_key = !self.show_api_key;
                        }
                        if ui.small_button("↩").clicked() {
                            self.reset_setting("secrets", "api_key");
                        }
                    });
                    ui.add_space(4.0);

                    ui.horizontal(|ui| {
                        ui.label("DB Password:");
                        if self.show_db_password {
                            let response = ui.text_edit_singleline(&mut self.db_password);
                            if response.lost_focus() {
                                self.save_setting(
                                    "secrets",
                                    "db_password",
                                    json!(self.db_password),
                                );
                            }
                        } else {
                            ui.label(if self.db_password.is_empty() {
                                "(empty)"
                            } else {
                                "••••••••"
                            });
                        }
                        if ui
                            .small_button(if self.show_db_password {
                                "👁"
                            } else {
                                "👁‍🗨"
                            })
                            .clicked()
                        {
                            self.show_db_password = !self.show_db_password;
                        }
                        if ui.small_button("↩").clicked() {
                            self.reset_setting("secrets", "db_password");
                        }
                    });

                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new("💡 Check 'Show JSON' - secrets won't appear there!")
                            .small()
                            .weak(),
                    );
                });

                ui.add_space(8.0);

                // ================================================================
                // ADVANCED SECTION
                // ================================================================
                ui.collapsing("⚙️ Advanced", |ui| {
                    ui.horizontal(|ui| {
                        let old_debug = self.debug;
                        ui.checkbox(&mut self.debug, "Debug Mode");
                        if self.debug != old_debug {
                            self.save_setting("advanced", "debug", json!(self.debug));
                        }
                        if ui.small_button("↩").clicked() {
                            self.reset_setting("advanced", "debug");
                        }
                    });
                });

                ui.add_space(8.0);

                // ================================================================
                // SUB-SETTINGS SECTION (Per-Entity Config)
                // ================================================================
                ui.collapsing("📂 Sub-Settings (Per-Entity Config)", |ui| {
                    ui.label(
                        egui::RichText::new("Each 'remote' is stored as a separate JSON file")
                            .small()
                            .weak(),
                    );
                    ui.add_space(8.0);

                    // Add new remote
                    ui.group(|ui| {
                        ui.label(egui::RichText::new("➕ Add Remote").strong());
                        ui.add_space(4.0);

                        ui.horizontal(|ui| {
                            ui.label("Name:");
                            ui.text_edit_singleline(&mut self.new_remote_name);
                        });

                        ui.horizontal(|ui| {
                            ui.label("Type:");
                            egui::ComboBox::from_id_salt("remote_type")
                                .selected_text(&self.new_remote_type)
                                .show_ui(ui, |ui| {
                                    ui.selectable_value(
                                        &mut self.new_remote_type,
                                        "drive".to_string(),
                                        "Google Drive",
                                    );
                                    ui.selectable_value(
                                        &mut self.new_remote_type,
                                        "s3".to_string(),
                                        "Amazon S3",
                                    );
                                    ui.selectable_value(
                                        &mut self.new_remote_type,
                                        "dropbox".to_string(),
                                        "Dropbox",
                                    );
                                    ui.selectable_value(
                                        &mut self.new_remote_type,
                                        "onedrive".to_string(),
                                        "OneDrive",
                                    );
                                });
                        });

                        ui.add_space(4.0);
                        if ui.button("➕ Add Remote").clicked() {
                            self.add_remote();
                        }
                    });

                    ui.add_space(8.0);

                    // List remotes
                    ui.group(|ui| {
                        ui.horizontal(|ui| {
                            ui.label(egui::RichText::new("📋 Existing Remotes").strong());
                            if ui.small_button("🔄 Refresh").clicked() {
                                self.refresh_remotes();
                            }
                        });
                        ui.add_space(4.0);

                        if self.remotes_list.is_empty() {
                            ui.label(egui::RichText::new("No remotes configured yet").weak());
                        } else {
                            for remote in self.remotes_list.clone() {
                                ui.horizontal(|ui| {
                                    let is_selected =
                                        self.selected_remote.as_ref() == Some(&remote);
                                    if ui.selectable_label(is_selected, &remote).clicked() {
                                        self.selected_remote = Some(remote.clone());
                                        self.load_remote_data(&remote);
                                    }
                                    if ui.small_button("🗑️").on_hover_text("Delete").clicked()
                                    {
                                        self.delete_remote(&remote);
                                    }
                                });
                            }
                        }
                    });

                    // Show selected remote data
                    if let Some(ref selected) = self.selected_remote.clone() {
                        ui.add_space(8.0);
                        ui.group(|ui| {
                            ui.label(egui::RichText::new(format!("📄 {}", selected)).strong());
                            ui.add_space(4.0);
                            ui.add(
                                egui::TextEdit::multiline(&mut self.selected_remote_data.clone())
                                    .code_editor()
                                    .desired_width(f32::INFINITY)
                                    .desired_rows(4),
                            );
                        });
                    }

                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new("💡 Files stored in ./example_config/remotes/")
                            .small()
                            .weak(),
                    );
                });

                ui.add_space(8.0);

                // ================================================================
                // BACKUP & RESTORE SECTION
                // ================================================================
                ui.collapsing("💾 Backup & Restore", |ui| {
                    ui.label(
                        egui::RichText::new("Create and restore encrypted or plain backups")
                            .small()
                            .weak(),
                    );
                    ui.add_space(8.0);

                    // Create backup subsection
                    ui.group(|ui| {
                        ui.label(egui::RichText::new("📦 Create Backup").strong());
                        ui.add_space(4.0);

                        ui.horizontal(|ui| {
                            ui.checkbox(&mut self.use_encryption, "Encrypt backup");
                            if self.use_encryption {
                                ui.label("Password:");
                                ui.add(
                                    egui::TextEdit::singleline(&mut self.backup_password)
                                        .password(true)
                                        .desired_width(120.0),
                                );
                            }
                        });

                        ui.horizontal(|ui| {
                            ui.label("Note (optional):");
                            ui.text_edit_singleline(&mut self.backup_note);
                        });

                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            if ui.button("📦 Create Backup").clicked() {
                                self.create_backup();
                            }
                            if let Some(ref path) = self.last_backup_path {
                                ui.label(
                                    egui::RichText::new(format!(
                                        "Last: {:?}",
                                        path.file_name().unwrap_or_default()
                                    ))
                                    .small()
                                    .weak(),
                                );
                            }
                        });
                    });

                    ui.add_space(8.0);

                    // Restore backup subsection
                    ui.group(|ui| {
                        ui.label(egui::RichText::new("♻️ Restore Backup").strong());
                        ui.add_space(4.0);

                        ui.horizontal(|ui| {
                            if ui.button("🔄 Refresh List").clicked() {
                                self.backup_list = Self::scan_backups();
                                self.status_message =
                                    format!("Found {} backups", self.backup_list.len());
                            }
                            ui.label(format!("{} backup(s) found", self.backup_list.len()));
                        });

                        if !self.backup_list.is_empty() {
                            ui.add_space(4.0);
                            let mut selection_changed = false;
                            egui::ComboBox::from_label("")
                                .selected_text(
                                    self.selected_backup_index
                                        .and_then(|i| {
                                            self.backup_list.get(i).map(|p| {
                                                p.file_name()
                                                    .unwrap_or_default()
                                                    .to_string_lossy()
                                                    .to_string()
                                            })
                                        })
                                        .unwrap_or_else(|| "Select a backup...".to_string()),
                                )
                                .show_ui(ui, |ui| {
                                    for (i, path) in self.backup_list.iter().enumerate() {
                                        let name = path
                                            .file_name()
                                            .unwrap_or_default()
                                            .to_string_lossy()
                                            .to_string();
                                        if ui
                                            .selectable_value(
                                                &mut self.selected_backup_index,
                                                Some(i),
                                                &name,
                                            )
                                            .clicked()
                                        {
                                            selection_changed = true;
                                        }
                                    }
                                });

                            // Analyze after loop to avoid borrow conflict
                            if selection_changed {
                                self.analyze_backup();
                            }
                            if self.restore_requires_password {
                                ui.horizontal(|ui| {
                                    ui.label("🔒 Password:");
                                    ui.add(
                                        egui::TextEdit::singleline(&mut self.restore_password)
                                            .password(true)
                                            .desired_width(120.0),
                                    );
                                });
                            }

                            ui.add_space(4.0);
                            ui.horizontal(|ui| {
                                if ui.button("🔍 Analyze").clicked() {
                                    self.analyze_backup();
                                }
                                if ui.button("♻️ Restore Selected").clicked() {
                                    self.restore_backup();
                                }
                            });

                            // Show analysis results
                            if let Some(ref analysis) = self.backup_analysis {
                                ui.add_space(4.0);
                                ui.group(|ui| {
                                    ui.label(egui::RichText::new(analysis).monospace().small());
                                });
                            }
                        }
                    });

                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new("💡 Backups are stored in ./example_config/backups/")
                            .small()
                            .weak(),
                    );
                });

                // ================================================================
                // JSON VIEW (shows what's actually stored)
                // ================================================================
                if self.show_json {
                    ui.add_space(16.0);
                    ui.separator();
                    ui.heading("📄 settings.json (actual file contents)");
                    ui.label(
                        egui::RichText::new(
                            "Only non-default values are stored! Secrets go to keychain!",
                        )
                        .small()
                        .weak(),
                    );
                    ui.add_space(4.0);

                    egui::ScrollArea::vertical()
                        .max_height(200.0)
                        .show(ui, |ui| {
                            ui.add(
                                egui::TextEdit::multiline(&mut self.current_json.clone())
                                    .code_editor()
                                    .desired_width(f32::INFINITY),
                            );
                        });
                }

                // ================================================================
                // HELP SECTION
                // ================================================================
                ui.add_space(16.0);
                ui.separator();
                ui.collapsing("❓ How rcman Works", |ui| {
                    ui.label("• Settings are defined via SettingsSchema trait");
                    ui.label("• Each setting has a type, default value, and metadata");
                    ui.label("• When you save a value = default, it's REMOVED from storage");
                    ui.label("• This keeps settings.json minimal (only customizations)");
                    ui.label("• Validation happens in save_setting() - invalid values rejected");
                    ui.label("• Secret settings (.secret()) go to OS keychain, not JSON file");
                    ui.label("• Resetting a secret removes it from keychain too!");
                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new(
                            "Check the 'Show JSON' checkbox to see what's actually stored!",
                        )
                        .weak(),
                    );
                });
            });
        });
    }
}

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([550.0, 700.0])
            .with_min_inner_size([400.0, 400.0]),
        ..Default::default()
    };

    eframe::run_native(
        "rcman GUI Demo",
        options,
        Box::new(|cc| Ok(Box::new(DemoApp::new(cc)))),
    )
}
