use chrono::Utc;
use log::LevelFilter;
use log::SetLoggerError;
use once_cell::sync::OnceCell;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc;

use crate::utils::types::all_types::DynamicLogger;
use crate::utils::types::all_types::LogCache;
use crate::utils::types::all_types::LogEntry;
use crate::utils::types::all_types::LogLevel;

// This will hold the "sender" part of our logging channel.
static LOG_SENDER: OnceCell<mpsc::Sender<LogEntry>> = OnceCell::new();

static LOG_LEVEL: AtomicUsize = AtomicUsize::new(LevelFilter::Info as usize);

impl log::Log for DynamicLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= current_log_level()
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            println!(
                "[{} [{}] {}]: {}",
                chrono::Local::now().format("%Y/%m/%d %H:%M:%S"),
                record.level(),
                record.target(),
                record.args()
            );
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

// --- Modified function to accept AppHandle ---
pub fn init_logging(enable_debug: bool, app_handle: AppHandle) -> Result<(), SetLoggerError> {
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

    let level = if enable_debug {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };

    LOG_LEVEL.store(level as usize, Ordering::Relaxed);
    log::set_max_level(level);
    log::set_logger(&DynamicLogger)?;
    Ok(())
}

pub fn update_log_level(enable_debug: bool) {
    let level = if enable_debug {
        LevelFilter::Debug
    } else {
        LevelFilter::Info
    };

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
