//! Archive handling utilities for backup/restore operations.
//!
//! This module provides low-level archive operations for the backup system:
//!
//! - **ZIP Creation**: [`create_zip_archive`] - Create compressed archives with optional AES-256 encryption
//! - **ZIP Extraction**: [`extract_zip_archive`] - Extract archives with password support
//! - **File Reading**: [`read_file_from_zip`] - Read individual files from archives
//! - **Container Creation**: [`create_rcman_container`] - Create the outer `.rcman` backup format
//! - **Hashing**: [`calculate_file_hash`] - SHA-256 checksums for integrity verification
//! - **Encryption Detection**: [`is_zip_encrypted`] - Check if an archive is encrypted
//!
//! # Backup Format
//!
//! The `.rcman` format is a nested ZIP structure:
//! ```text
//! backup.rcman (outer ZIP, uncompressed)
//! ├── manifest.json    # Metadata, checksums, version info
//! └── data.zip         # Inner archive (compressed, optionally encrypted)
//!     ├── settings.json
//!     ├── remotes/
//!     └── ...
//! ```

use super::types::ProgressCallback;
use crate::error::{Error, Result};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
use zip::write::{FileOptions, SimpleFileOptions};
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// Writer wrapper that counts bytes and calls progress callback
struct CountWriter<W: Write> {
    inner: W,
    callback: Option<ProgressCallback>,
    total_bytes: u64,
    written_bytes: u64,
}

impl<W: Write> Write for CountWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.written_bytes += n as u64;
        if let Some(cb) = &self.callback {
            cb(self.written_bytes, self.total_bytes);
        }
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

impl<W: Write + std::io::Seek> std::io::Seek for CountWriter<W> {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
        self.inner.seek(pos)
    }
}

/// Create a zip archive from a directory
pub fn create_zip_archive(
    source_dir: &Path,
    output_path: &Path,
    progress_callback: Option<ProgressCallback>,
    total_size: u64,
    password: Option<&str>,
) -> Result<()> {
    let file = File::create(output_path).map_err(|e| Error::FileWrite {
        path: output_path.to_path_buf(),
        source: e,
    })?;

    let writer = CountWriter {
        inner: file,
        callback: progress_callback,
        total_bytes: total_size,
        written_bytes: 0,
    };

    let mut zip = ZipWriter::new(writer);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    if let Some(pwd) = password {
        let options = options.with_aes_encryption(zip::AesMode::Aes256, pwd);
        add_directory_to_zip(&mut zip, source_dir, source_dir, &options)?;
    } else {
        add_directory_to_zip(&mut zip, source_dir, source_dir, &options)?;
    }

    zip.finish().map_err(|e| Error::Archive(e.to_string()))?;
    Ok(())
}

/// Recursively add a directory to a zip archive
fn add_directory_to_zip<W: Write + std::io::Seek>(
    zip: &mut ZipWriter<W>,
    base_dir: &Path,
    current_dir: &Path,
    options: &FileOptions<()>,
) -> Result<()> {
    for entry in std::fs::read_dir(current_dir).map_err(|e| Error::FileRead {
        path: current_dir.to_path_buf(),
        source: e,
    })? {
        let entry = entry.map_err(|e| Error::FileRead {
            path: current_dir.to_path_buf(),
            source: e,
        })?;

        let path = entry.path();
        let relative_path = path
            .strip_prefix(base_dir)
            .map_err(|e| Error::Archive(e.to_string()))?;

        // Zip uses '/' as directory separator independent of host platform.
        let name = relative_path
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");

        if path.is_dir() {
            // Add directory entry
            zip.add_directory(format!("{name}/"), *options)
                .map_err(|e| Error::Archive(e.to_string()))?;

            // Recurse into directory
            add_directory_to_zip(zip, base_dir, &path, options)?;
        } else {
            // Add file
            zip.start_file(name.clone(), *options)
                .map_err(|e| Error::Archive(e.to_string()))?;

            let mut file = File::open(&path).map_err(|e| Error::FileRead {
                path: path.clone(),
                source: e,
            })?;

            std::io::copy(&mut file, zip).map_err(|e| Error::FileRead {
                path: path.clone(),
                source: e,
            })?;
        }
    }

    Ok(())
}

/// Extract a zip archive to a directory
pub fn extract_zip_archive(
    archive_path: &Path,
    output_dir: &Path,
    password: Option<&str>,
) -> Result<()> {
    let file = File::open(archive_path).map_err(|e| Error::FileRead {
        path: archive_path.to_path_buf(),
        source: e,
    })?;

    let mut archive = ZipArchive::new(file)?;

    for i in 0..archive.len() {
        let mut file = match password {
            Some(pwd) => archive.by_index_decrypt(i, pwd.as_bytes()).map_err(|e| {
                if let zip::result::ZipError::InvalidPassword = e {
                    Error::InvalidPassword
                } else {
                    Error::Archive(e.to_string())
                }
            })?,
            None => archive.by_index(i)?,
        };

        let outpath = output_dir.join(file.mangled_name());

        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath).map_err(|e| Error::DirectoryCreate {
                path: outpath.clone(),
                source: e,
            })?;
        } else {
            if let Some(parent) = outpath.parent()
                && !parent.exists()
            {
                crate::utils::security::ensure_secure_dir(parent)?;
            }

            let mut outfile = File::create(&outpath).map_err(|e| Error::FileWrite {
                path: outpath.clone(),
                source: e,
            })?;

            std::io::copy(&mut file, &mut outfile).map_err(|e| Error::FileWrite {
                path: outpath.clone(),
                source: e,
            })?;
        }
    }

    Ok(())
}

/// Check if a ZIP archive's first entry is encrypted
///
/// Returns `true` if the archive contains encrypted entries, `false` otherwise.
/// This is useful for validating backup encryption status.
pub fn is_zip_encrypted(archive_path: &Path) -> Result<bool> {
    let file = File::open(archive_path).map_err(|e| Error::FileRead {
        path: archive_path.to_path_buf(),
        source: e,
    })?;

    let mut archive = ZipArchive::new(file)?;

    // Check if any entry is encrypted
    for i in 0..archive.len() {
        if let Ok(entry) = archive.by_index_raw(i)
            && entry.encrypted()
        {
            return Ok(true);
        }
    }

    Ok(false)
}

/// Read a file from a zip archive
pub fn read_file_from_zip(archive_path: &Path, filename: &str) -> Result<Vec<u8>> {
    let file = File::open(archive_path).map_err(|e| Error::FileRead {
        path: archive_path.to_path_buf(),
        source: e,
    })?;

    let mut archive = ZipArchive::new(file)?;
    let mut zip_file = archive
        .by_name(filename)
        .map_err(|e| Error::Archive(format!("File '{filename}' not found in archive: {e}")))?;

    let mut contents = Vec::new();
    zip_file
        .read_to_end(&mut contents)
        .map_err(|e| Error::FileRead {
            path: std::path::PathBuf::from(filename),
            source: e,
        })?;

    Ok(contents)
}

/// Calculate SHA-256 hash of a file
pub fn calculate_file_hash(path: &Path) -> Result<(String, u64)> {
    let mut file = File::open(path).map_err(|e| Error::FileRead {
        path: path.to_path_buf(),
        source: e,
    })?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    let mut total_size = 0u64;

    loop {
        let bytes_read = file.read(&mut buffer).map_err(|e| Error::FileRead {
            path: path.to_path_buf(),
            source: e,
        })?;

        if bytes_read == 0 {
            break;
        }

        total_size += bytes_read as u64;
        hasher.update(&buffer[..bytes_read]);
    }

    let raw_hash = hasher.finalize();
    let hash = raw_hash
        .iter()
        .fold(String::with_capacity(raw_hash.len() * 2), |mut s, &b| {
            s.push(std::char::from_digit(u32::from(b >> 4), 16).unwrap());
            s.push(std::char::from_digit(u32::from(b & 0x0F), 16).unwrap());
            s
        });
    Ok((hash, total_size))
}

/// Create the outer .rcman container (zip with manifest + data archive)
pub fn create_rcman_container(
    output_path: &Path,
    manifest_json: &str,
    manifest_filename: &str,
    inner_archive_path: &Path,
    inner_archive_filename: &str,
) -> Result<()> {
    let file = File::create(output_path).map_err(|e| Error::FileWrite {
        path: output_path.to_path_buf(),
        source: e,
    })?;

    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored); // Don't compress the container

    // Add manifest
    zip.start_file(manifest_filename, options)
        .map_err(|e| Error::Archive(e.to_string()))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| Error::Archive(e.to_string()))?;

    // Add data archive
    zip.start_file(inner_archive_filename, options)
        .map_err(|e| Error::Archive(e.to_string()))?;

    let mut inner_file = File::open(inner_archive_path).map_err(|e| Error::FileRead {
        path: inner_archive_path.to_path_buf(),
        source: e,
    })?;

    std::io::copy(&mut inner_file, &mut zip).map_err(|e| Error::FileRead {
        path: inner_archive_path.to_path_buf(),
        source: e,
    })?;

    zip.finish().map_err(|e| Error::Archive(e.to_string()))?;
    Ok(())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_create_and_extract_zip() {
        let temp = tempdir().unwrap();
        let src_dir = temp.path().join("source");
        let archive_path = temp.path().join("test.zip");
        let extract_dir = temp.path().join("extracted");

        // Create source directory with files
        std::fs::create_dir_all(src_dir.join("subdir")).unwrap();
        std::fs::write(src_dir.join("file1.txt"), "hello").unwrap();
        std::fs::write(src_dir.join("subdir/file2.txt"), "world").unwrap();

        // Create archive
        create_zip_archive(&src_dir, &archive_path, None, 0, None).unwrap();
        assert!(archive_path.exists());

        // Extract archive
        extract_zip_archive(&archive_path, &extract_dir, None).unwrap();

        // Verify contents
        assert_eq!(
            std::fs::read_to_string(extract_dir.join("file1.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            std::fs::read_to_string(extract_dir.join("subdir/file2.txt")).unwrap(),
            "world"
        );
    }

    #[test]
    fn test_read_file_from_zip() {
        let temp = tempdir().unwrap();
        let src_dir = temp.path().join("source");
        let archive_path = temp.path().join("test.zip");

        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::write(src_dir.join("data.json"), r#"{"key": "value"}"#).unwrap();

        create_zip_archive(&src_dir, &archive_path, None, 0, None).unwrap();

        let contents = read_file_from_zip(&archive_path, "data.json").unwrap();
        assert_eq!(String::from_utf8(contents).unwrap(), r#"{"key": "value"}"#);
    }

    #[test]
    fn test_calculate_file_hash() {
        let temp = tempdir().unwrap();
        let file_path = temp.path().join("test.txt");
        std::fs::write(&file_path, "test content").unwrap();

        let (hash, size) = calculate_file_hash(&file_path).unwrap();

        assert!(!hash.is_empty());
        assert_eq!(size, 12); // "test content" = 12 bytes
    }
}
