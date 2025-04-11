use std::{fs, path::Path};
use zip::ZipArchive;
use std::io::Cursor;

pub fn extract_rclone_zip(
    zip_bytes: &[u8],
    temp_dir: &Path
) -> Result<(), String> {
    if temp_dir.exists() {
        fs::remove_dir_all(temp_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(temp_dir).map_err(|e| e.to_string())?;

    let extract_path = temp_dir.join("rclone");
    fs::create_dir_all(&extract_path).map_err(|e| e.to_string())?;

    let reader = Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(reader).map_err(|e| e.to_string())?;
    archive.extract(&extract_path).map_err(|e| e.to_string())?;

    Ok(())
}
