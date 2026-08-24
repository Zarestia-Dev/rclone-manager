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
