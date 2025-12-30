//! Rotating file writer for log files
//!
//! Provides a thread-safe rotating file writer that automatically rotates
//! log files when they exceed a maximum size, keeping only a configurable
//! number of backup files.

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

    /// Rotate log files
    fn rotate(&mut self) -> io::Result<()> {
        // Close current file
        self.current_file = None;

        // Delete oldest backup if we have too many
        let oldest = format!("{}.{}", self.base_path.display(), MAX_BACKUP_FILES);
        if Path::new(&oldest).exists() {
            fs::remove_file(&oldest)?;
        }

        // Rotate existing backups: .4 -> .5, .3 -> .4, etc.
        for i in (1..MAX_BACKUP_FILES).rev() {
            let from = format!("{}.{}", self.base_path.display(), i);
            let to = format!("{}.{}", self.base_path.display(), i + 1);
            if Path::new(&from).exists() {
                fs::rename(&from, &to)?;
            }
        }

        // Rename current log to .1
        if self.base_path.exists() {
            let backup_path = format!("{}.1", self.base_path.display());
            fs::rename(&self.base_path, backup_path)?;
        }

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
