use crate::utils::types::updater::InstallOutcome;

/// Hand the verified APK to Android's installer. `path` is the payload cache, which
/// the download wrote; it is rewritten only when the cache was cleared meanwhile.
/// Android checks the package name, version code and signers again (Kotlin side).
pub(super) fn install(path: &std::path::Path, payload: &[u8]) -> Result<InstallOutcome, String> {
    use std::io::Write;
    let root = path
        .parent()
        .ok_or_else(|| crate::localized_error!("backendErrors.updater.invalidStagingDirectory"))?;
    // Earlier versions kept the cache under another name and a second copy.
    let _ = std::fs::remove_file(root.join("update.apk"));
    let _ = std::fs::remove_file(path.with_extension("payload"));
    let cached = std::fs::metadata(path).is_ok_and(|m| m.len() == payload.len() as u64);
    if !cached {
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
        file.write_all(payload).map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(path).map_err(|e| e.to_string())?;
    }
    match crate::rclone::backend::saf_bridge::install_update_apk(
        path.to_str().ok_or_else(|| {
            crate::localized_error!("backendErrors.updater.invalidStagingDirectory")
        })?,
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
