use crate::utils::types::updater::InstallOutcome;

pub(super) fn install(root: &std::path::Path, payload: &[u8]) -> Result<InstallOutcome, String> {
    use std::io::Write;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = root.join("update.apk");
    let mut file = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    file.write_all(payload).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(&path).map_err(|e| e.to_string())?;
    match crate::rclone::backend::saf_bridge::install_update_apk(
        path.to_str().ok_or("Invalid APK path")?,
    )? {
        0 => Ok(InstallOutcome::AwaitingUser),
        1 => Err(crate::localized_error!(
            "backendErrors.updater.androidInstallPermission"
        )),
        _ => Err(crate::localized_error!(
            "backendErrors.updater.invalidAndroidPackage"
        )),
    }
}
