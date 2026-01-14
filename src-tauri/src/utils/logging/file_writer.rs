//! Rotating file writer for log files
//!
//! Provides a thread-safe rotating file writer that automatically rotates
//! log files when they exceed a maximum size, using timestamp-based naming
//! similar to rclone's log rotation.

use chrono::Utc;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Maximum file size before rotation (5 MB)
const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;

/// Maximum number of backup files to keep
const MAX_BACKUP_FILES: usize = 5;

/// A rotating file writer that automatically rotates log files
pub struct RotatingFileWriter {
    base_path: PathBuf,
    current_file: Option<File>,
    current_size: u64,
}

impl RotatingFileWriter {
    /// Create a new rotating file writer
    pub fn new(log_dir: &Path) -> io::Result<Self> {
        // Ensure log directory exists
        fs::create_dir_all(log_dir)?;

        let base_path = log_dir.join("rclone-manager.log");
        let current_size = if base_path.exists() {
            fs::metadata(&base_path)?.len()
        } else {
            0
        };

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&base_path)?;

        Ok(Self {
            base_path,
            current_file: Some(file),
            current_size,
        })
    }

    /// Rotate log files using timestamp-based naming
    fn rotate(&mut self) -> io::Result<()> {
        // Close current file
        self.current_file = None;

        // Create timestamped backup name: rclone-manager-2025-04-11T17-15-29.998.log
        let timestamp = Utc::now().format("%Y-%m-%dT%H-%M-%S%.3f");
        let file_stem = self
            .base_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("rclone-manager");
        let backup_path = self
            .base_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(format!("{}-{}.log", file_stem, timestamp));

        // Rename current log to timestamped backup
        if self.base_path.exists() {
            fs::rename(&self.base_path, &backup_path)?;
        }

        // Clean up old backups if we have too many
        self.cleanup_old_backups()?;

        // Open new file
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.base_path)?;

        self.current_file = Some(file);
        self.current_size = 0;

        Ok(())
    }

    /// Remove old backup files, keeping only MAX_BACKUP_FILES
    fn cleanup_old_backups(&self) -> io::Result<()> {
        let log_dir = self.base_path.parent().unwrap_or_else(|| Path::new("."));
        let file_stem = self
            .base_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("rclone-manager");

        // Get all backup files and sort by modification time
        let mut backups: Vec<PathBuf> = fs::read_dir(log_dir)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| {
                        name.starts_with(file_stem) && name.contains('-') && name.ends_with(".log")
                    })
                    .unwrap_or(false)
                    && path != &self.base_path // Don't delete the current log
            })
            .collect();

        // Sort by modification time (oldest first)
        backups.sort_by_key(|path| {
            fs::metadata(path)
                .and_then(|m| m.modified())
                .unwrap_or(chrono::Utc::now().into())
        });

        // Delete oldest backups if we have too many
        while backups.len() >= MAX_BACKUP_FILES {
            if let Some(old) = backups.first() {
                let _ = fs::remove_file(old);
                backups.remove(0);
            } else {
                break;
            }
        }

        Ok(())
    }

    /// Write a log line, rotating if necessary
    pub fn write_line(&mut self, line: &str) -> io::Result<()> {
        let bytes = line.as_bytes();
        let len = bytes.len() as u64 + 1; // +1 for newline

        // Rotate if needed
        if self.current_size + len > MAX_FILE_SIZE {
            self.rotate()?;
        }

        // Write to file
        if let Some(ref mut file) = self.current_file {
            file.write_all(bytes)?;
            file.write_all(b"\n")?;
            file.flush()?;
            self.current_size += len;
        }

        Ok(())
    }
}

/// Global rotating file writer wrapped in a Mutex for thread safety
static FILE_WRITER: once_cell::sync::OnceCell<Mutex<RotatingFileWriter>> =
    once_cell::sync::OnceCell::new();

/// Initialize the file writer with a log directory
pub fn init_file_writer(log_dir: &Path) -> io::Result<()> {
    let writer = RotatingFileWriter::new(log_dir)?;
    FILE_WRITER.set(Mutex::new(writer)).map_err(|_| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "File writer already initialized",
        )
    })
}

/// Write a log line to the rotating file
pub fn write_to_file(line: &str) {
    if let Some(writer) = FILE_WRITER.get()
        && let Ok(mut guard) = writer.lock()
        && let Err(e) = guard.write_line(line)
    {
        eprintln!("Failed to write to log file: {e}");
    }
}
