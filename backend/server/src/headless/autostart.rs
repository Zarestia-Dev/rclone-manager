//! Start at login. The entry is rewritten on every start, so it always runs this
//! executable.
fn entry(name: &str) -> Result<auto_launch::AutoLaunch, String> {
    auto_launch::AutoLaunchBuilder::new()
        .set_app_name(name)
        .set_app_path(&super::lifecycle::executable()?.display().to_string())
        .build()
        .map_err(|error| error.to_string())
}

pub(super) fn set(enabled: bool) {
    // A development build must not register itself to start at login.
    if cfg!(debug_assertions) && enabled {
        return;
    }
    let result = entry(crate::PRODUCT.display_name).and_then(|entry| {
        if enabled {
            entry.enable()
        } else {
            entry.disable()
        }
        .map_err(|error| error.to_string())
    });
    if let Err(error) = result {
        log::error!(
            "Failed to {} start at login: {error}",
            if enabled { "enable" } else { "disable" }
        );
    }
}

/// Removes the entry of the RClone Manager Headless app, which started a path and an
/// argument that this server replaced. `set` writes the server's own entry.
pub(super) fn remove_legacy_entry() {
    if cfg!(debug_assertions) {
        return;
    }
    let result = entry(super::LEGACY_NAME).and_then(|entry| match entry.is_enabled() {
        Ok(true) => entry.disable().map_err(|error| error.to_string()),
        Ok(false) => Ok(()),
        Err(error) => Err(error.to_string()),
    });
    if let Err(error) = result {
        log::error!(
            "Failed to remove the start-at-login entry of {}: {error}",
            super::LEGACY_NAME
        );
    }
}
