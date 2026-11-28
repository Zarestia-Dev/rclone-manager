//! Native executable composition. Core has no dependency on this crate.
use crate::context::AppHandle;

pub(crate) const APP_ID: &str = "io.github.zarestia_dev.rclone-manager";
#[cfg(all(target_os = "linux", feature = "tauri-plugin-single-instance"))]
pub(crate) const APP_ID_DEV: &str = "io.github.zarestia_dev.rclone-manager-dev";

pub(crate) const PRODUCT: rclone_manager_core::context::ProductInfo =
    rclone_manager_core::context::ProductInfo {
        display_name: "RClone Manager",
        mode: "desktop",
        release_prefix: "v",
        integration_key: "RCloneManager",
        flatpak_id: APP_ID,
    };

#[cfg(target_os = "android")]
pub(crate) fn setup_context(
    app: &AppHandle,
    _args: crate::cli::CliArgs,
) -> Result<(), Box<dyn std::error::Error>> {
    crate::native::android::attach(app)
}

#[cfg(not(target_os = "android"))]
pub(crate) fn setup_context(
    app: &AppHandle,
    args: crate::cli::CliArgs,
) -> Result<(), Box<dyn std::error::Error>> {
    use rclone_manager_core::context::AppHandle as CoreHandle;
    use std::sync::Arc;
    use tauri::Manager;

    let context = CoreHandle::new(
        Arc::new(crate::native::host::NativeHost(app.clone())),
        PRODUCT,
    );
    context.manage(args.general.clone());
    app.manage(args.clone());
    app.manage(context.clone());
    let sink: Option<Arc<dyn crate::services::bridge::event::EventSink>> = Some(Arc::new(
        crate::native::events::WebviewEventSink(app.clone()),
    ));
    rclone_manager_core::app::setup_context(&context, sink)?;
    crate::native::setup::start(app)?;
    crate::native::setup::present(app, &args);
    rclone_manager_core::app::send_to::start(&context, args.general);
    crate::native::setup::finish(app);
    Ok(())
}
