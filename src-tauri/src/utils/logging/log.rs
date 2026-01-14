use chrono::Utc;
use log::LevelFilter;
use once_cell::sync::OnceCell;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::utils::types::core::DynamicLogger;
use crate::utils::types::logs::LogCache;
use crate::utils::types::logs::LogEntry;
use crate::utils::types::logs::LogLevel;

use super::file_writer::write_to_file;

// This will hold the "sender" part of our logging channel.
static LOG_SENDER: OnceCell<mpsc::Sender<LogEntry>> = OnceCell::new();

static LOG_LEVEL: AtomicUsize = AtomicUsize::new(LevelFilter::Info as usize);

impl log::Log for DynamicLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= current_log_level()
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            let log_line = format!(
                "[{} [{}] {}]: {}",
                chrono::Local::now().format("%Y/%m/%d %H:%M:%S"),
                record.level(),
                record.target(),
                record.args()
            );

            // Write to console
            println!("{}", log_line);

            // Write to rotating log file
            write_to_file(&log_line);
        }
    }

    fn flush(&self) {}
}

fn current_log_level() -> LevelFilter {
    match LOG_LEVEL.load(Ordering::Relaxed) {
        x if x == LevelFilter::Off as usize => LevelFilter::Off,
        x if x == LevelFilter::Error as usize => LevelFilter::Error,
        x if x == LevelFilter::Warn as usize => LevelFilter::Warn,
        x if x == LevelFilter::Info as usize => LevelFilter::Info,
        x if x == LevelFilter::Debug as usize => LevelFilter::Debug,
        x if x == LevelFilter::Trace as usize => LevelFilter::Trace,
        _ => LevelFilter::Info,
    }
}

/// Parse log level string to LevelFilter
fn parse_log_level(level: &str) -> LevelFilter {
    match level.to_lowercase().as_str() {
        "error" => LevelFilter::Error,
        "warn" => LevelFilter::Warn,
        "info" => LevelFilter::Info,
        "debug" => LevelFilter::Debug,
        "trace" => LevelFilter::Trace,
        _ => LevelFilter::Info, // Default to info
    }
}

// --- Modified function to accept AppHandle ---
pub fn init_logging(log_level: &str, app_handle: AppHandle) -> Result<(), String> {
    // Initialize rotating file logger using cache directory
    use tauri::Manager;

    let paths = crate::core::paths::AppPaths::from_app_handle(&app_handle)?;
    let log_dir = paths.get_app_log_dir();

    if let Err(e) = super::file_writer::init_file_writer(&log_dir) {
        eprintln!("Failed to initialize file logger: {e}");
        return Err(format!("Failed to initialize file logger: {e}"));
    }

    let (tx, mut rx) = mpsc::channel::<LogEntry>(1000);

    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let log_cache = app_handle_clone.state::<LogCache>();
        while let Some(entry) = rx.recv().await {
            log_cache.add_entry_from_processor(entry).await;
        }
    });

    if LOG_SENDER.set(tx).is_err() {
        eprintln!("CRITICAL: Failed to set LOG_SENDER. Logging will not work.");
    }

    let level = parse_log_level(log_level);

    LOG_LEVEL.store(level as usize, Ordering::Relaxed);
    log::set_max_level(level);
    log::set_logger(&DynamicLogger).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn update_log_level(log_level: &str) {
    let level = parse_log_level(log_level);

    LOG_LEVEL.store(level as usize, Ordering::Relaxed);
    log::set_max_level(level);
}

// It uses the mpsc channel (LOG_SENDER), not LOG_CACHE directly.
pub fn log_operation(
    level: LogLevel,
    remote_name: Option<String>,
    operation: Option<String>,
    message: impl Into<String>,
    context: Option<Value>,
) {
    let entry = LogEntry {
        timestamp: Utc::now(),
        remote_name,
        level: level.clone(),
        message: message.into(),
        context,
        operation,
    };

    if let Some(sender) = LOG_SENDER.get() {
        if let Err(e) = sender.try_send(entry) {
            eprintln!(
                "Failed to send log message to processor (channel full?): {}",
                e
            );
        }
    } else {
        eprintln!("Log sender not initialized. Log entry dropped.");
    }
}
