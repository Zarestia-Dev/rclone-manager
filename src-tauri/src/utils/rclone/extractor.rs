use std::{fs, path::Path};
use zip::ZipArchive;

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

#[cfg(test)]
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
}
