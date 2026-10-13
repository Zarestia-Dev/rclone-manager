//! Native executable composition. Core has no dependency on this crate.
use crate::context::AppHandle;
use rclone_manager_core::context::AppHandle as CoreHandle;
use std::sync::Arc;
use tauri::Manager;
pub(crate) fn setup_context(
    app: &AppHandle,
    args: crate::cli::CliArgs,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(feature = "web-server")]
    let product = rclone_manager_server::PRODUCT;
    #[cfg(not(feature = "web-server"))]
    let product = rclone_manager_core::context::ProductInfo {
        display_name: "RClone Manager",
        mode: "desktop",
        release_prefix: "v",
        integration_key: "RCloneManager",
        flatpak_id: crate::utils::app::platform::APP_ID,
    };
    let context = CoreHandle::new(
        Arc::new(crate::native::host::NativeHost(app.clone())),
        product,
    );
    context.manage(args.general.clone());
    app.manage(args.clone());
    app.manage(context.clone());
    #[cfg(not(feature = "web-server"))]
    let sink: Option<Arc<dyn crate::services::bridge::event::EventSink>> = Some(Arc::new(
        crate::native::events::WebviewEventSink(app.clone()),
    ));
    #[cfg(feature = "web-server")]
    let sink = None;
    rclone_manager_core::app::setup_context(&context, sink)?;
    crate::native::setup::start(app)?;
    #[cfg(feature = "web-server")]
    let _server = rclone_manager_server::start(
        &context,
        &args.headless,
        context
            .state::<Arc<crate::services::bridge::EventBridge>>()
            .inner(),
    );
    crate::native::setup::present(app, &args);
    rclone_manager_core::app::send_to::start(&context, args.general);
    crate::native::setup::finish(app);
    Ok(())
}
