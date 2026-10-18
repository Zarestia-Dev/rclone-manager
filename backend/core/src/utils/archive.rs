use std::{fs, path::Path};
use zip::ZipArchive;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn extract_rclone_zip(zip_file: &Path, extract_to: &Path) -> Result<(), String> {
    if extract_to.exists() {
        fs::remove_dir_all(extract_to).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(extract_to).map_err(|e| e.to_string())?;

    let file = fs::File::open(zip_file).map_err(|e| format!("Failed to open zip file: {e}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {e}"))?;
    archive
        .extract(extract_to)
        .map_err(|e| format!("Failed to extract zip archive: {e}"))?;

    Ok(())
}

#[cfg(feature = "updater")]
pub(crate) fn safe_member_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .trim_end_matches('/')
            .split('/')
            .all(|part| !matches!(part, "" | "." | ".."))
}

/// Inspect every member before reading or extracting a portable package.
#[cfg(feature = "updater")]
fn inspect_portable_zip<'a>(
    bytes: &'a [u8],
    bundle_root: Option<&str>,
) -> Result<ZipArchive<std::io::Cursor<&'a [u8]>>, String> {
    let mut archive = ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut expanded = 0_u64;
    if archive.len() > 4096 {
        return Err("ZIP contains too many entries".into());
    }
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let path = entry.name();
        if !safe_member_path(path)
            || entry.unix_mode().is_some_and(|mode| {
                mode & 0o170000 != 0 && !matches!(mode & 0o170000, 0o100000 | 0o040000)
            })
            || bundle_root.is_some_and(|root| {
                path.trim_end_matches('/') != root && !path.starts_with(&format!("{root}/"))
            })
        {
            return Err("ZIP contains an unsafe path, link or special file".into());
        }
        expanded = expanded
            .checked_add(entry.size())
            .ok_or("ZIP size overflow")?;
        if expanded > 1024 * 1024 * 1024 {
            return Err("ZIP exceeds extraction limits".into());
        }
    }
    Ok(archive)
}

/// Read just the expected executable; settings and other archive entries stay untouched.
#[cfg(feature = "updater")]
pub(crate) fn read_zip_member(
    bytes: &[u8],
    member: &str,
    size: u64,
    bundle_root: Option<&str>,
) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut archive = inspect_portable_zip(bytes, bundle_root)?;
    let entry = archive.by_name(member).map_err(|e| e.to_string())?;
    if entry.is_dir() || entry.size() != size {
        return Err("ZIP executable size or type does not match".into());
    }
    let mut binary = Vec::new();
    entry
        .take(size + 1)
        .read_to_end(&mut binary)
        .map_err(|e| e.to_string())?;
    if binary.len() as u64 != size {
        return Err("ZIP executable size does not match".into());
    }
    Ok(binary)
}

/// Unpack one already authenticated macOS app into a fresh staging directory.
#[cfg(feature = "updater")]
pub(crate) fn extract_zip_bundle(
    bytes: &[u8],
    destination: &Path,
    root: &str,
) -> Result<(), String> {
    let mut archive = inspect_portable_zip(bytes, Some(root))?;
    fs::create_dir(destination).map_err(|e| e.to_string())?;
    archive.extract(destination).map_err(|e| e.to_string())
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    #[test]
    fn extracts_deflated_and_stored_entries_and_replaces_old_contents() {
        let temp = tempfile::tempdir().unwrap();
        let archive_path = temp.path().join("rclone.zip");
        let output = temp.path().join("extracted");
        fs::create_dir(&output).unwrap();
        fs::write(output.join("stale"), b"old").unwrap();

        let mut archive = ZipWriter::new(fs::File::create(&archive_path).unwrap());
        for (name, method, contents) in [
            (
                "rclone-release/rclone",
                CompressionMethod::Deflated,
                b"binary".as_slice(),
            ),
            (
                "rclone-release/README.txt",
                CompressionMethod::Stored,
                b"readme".as_slice(),
            ),
            (
                "rclone-release/empty",
                CompressionMethod::Deflated,
                b"".as_slice(),
            ),
        ] {
            archive
                .start_file(
                    name,
                    SimpleFileOptions::default().compression_method(method),
                )
                .unwrap();
            archive.write_all(contents).unwrap();
        }
        archive.finish().unwrap();

        extract_rclone_zip(&archive_path, &output).unwrap();

        assert_eq!(
            fs::read(output.join("rclone-release/rclone")).unwrap(),
            b"binary"
        );
        assert_eq!(
            fs::read(output.join("rclone-release/README.txt")).unwrap(),
            b"readme"
        );
        assert!(
            fs::read(output.join("rclone-release/empty"))
                .unwrap()
                .is_empty()
        );
        assert!(!output.join("stale").exists());
    }

    #[test]
    fn rejects_missing_and_invalid_archives() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("rclone.zip");
        let output = temp.path().join("extracted");

        assert!(
            extract_rclone_zip(&archive, &output)
                .unwrap_err()
                .contains("Failed to open zip file")
        );
        fs::write(&archive, b"not a ZIP archive").unwrap();
        assert!(
            extract_rclone_zip(&archive, &output)
                .unwrap_err()
                .contains("Failed to read zip archive")
        );
    }

    #[cfg(feature = "updater")]
    #[test]
    fn portable_reader_selects_only_the_binary_and_enforces_size_and_paths() {
        let bytes = include_bytes!("../services/updates/fixtures/portable-linux-x86_64-99.0.0.zip");
        let member = "RCloneManager/RCloneManager";
        let binary = include_bytes!("../services/updates/fixtures/payload.txt");
        assert_eq!(
            read_zip_member(bytes, member, binary.len() as u64, None).unwrap(),
            binary
        );
        assert!(read_zip_member(bytes, member, 1, None).is_err());
        assert!(read_zip_member(bytes, "missing", 1, None).is_err());
        assert!(read_zip_member(b"not a ZIP", member, 1, None).is_err());
        for path in [
            "",
            "../binary",
            "/absolute",
            "C:/binary",
            "a\\b",
            "a/./b",
            "a//b",
            "a\nb",
        ] {
            assert!(!safe_member_path(path));
        }
        for path in ["../binary", "/binary", "C:/binary"] {
            let mut archive = ZipWriter::new(std::io::Cursor::new(Vec::new()));
            archive
                .start_file(path, SimpleFileOptions::default())
                .unwrap();
            archive.write_all(b"abc").unwrap();
            let bytes = archive.finish().unwrap().into_inner();
            assert!(read_zip_member(&bytes, path, 3, None).is_err());
        }
        let mut archive = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        archive
            .add_symlink("binary", "outside", SimpleFileOptions::default())
            .unwrap();
        let bytes = archive.finish().unwrap().into_inner();
        assert!(read_zip_member(&bytes, "binary", 7, None).is_err());
    }

    #[cfg(feature = "updater")]
    #[test]
    fn bundle_extraction_rejects_an_existing_destination_and_entries_outside_the_app() {
        let bytes =
            include_bytes!("../services/updates/fixtures/portable-macos-aarch64-99.0.0.zip");
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("candidate");
        extract_zip_bundle(bytes, &destination, "RClone Manager.app").unwrap();
        assert_eq!(
            fs::read(destination.join("RClone Manager.app/Contents/Info.plist")).unwrap(),
            b"<plist/>"
        );
        assert!(extract_zip_bundle(bytes, &destination, "RClone Manager.app").is_err());
        let linux_zip =
            include_bytes!("../services/updates/fixtures/portable-linux-x86_64-99.0.0.zip");
        assert!(
            extract_zip_bundle(linux_zip, &root.path().join("unsafe"), "RClone Manager.app")
                .is_err()
        );
        assert!(!root.path().join("unsafe").exists());
    }
}
