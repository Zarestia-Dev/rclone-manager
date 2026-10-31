//! Android runs the shared backend without waiting for an activity, so the foreground service
//! can start it after a boot. Tauri attaches to that backend when the activity first opens.
use crate::cli::CliArgs;
use crate::context::AppHandle;
use crate::services::paths::AppPaths;
use clap::Parser;
use jni::{
    EnvUnowned,
    objects::{JClass, JString},
    sys::{jboolean, jstring},
};
use rclone_manager_core::context::{AppHandle as CoreHandle, Host};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use tauri::Manager;

static CORE: Mutex<Option<CoreHandle>> = Mutex::new(None);
static TAURI: OnceLock<AppHandle> = OnceLock::new();

/// The parts of the platform the backend needs that do not depend on Tauri.
struct AndroidHost(AppPaths);

#[async_trait::async_trait]
impl Host for AndroidHost {
    fn update_method(&self) -> crate::services::updates::policy::UpdateMethod {
        crate::services::updates::policy::UpdateMethod::Android
    }

    fn resolve_paths(&self, _app: &CoreHandle) -> Result<AppPaths, String> {
        Ok(self.0.clone())
    }

    fn restart(&self, _app: &CoreHandle) -> Result<(), String> {
        match TAURI.get() {
            Some(app) => app.restart(),
            None => Err(rclone_manager_core::localized_error!(
                "backendErrors.updater.relaunchFailed",
                "error" => "no window"
            )),
        }
    }

    fn exit(&self, code: i32) {
        // Tauri 2.12 exits once the activity is destroyed, which keep-alive would otherwise
        // turn into a preserved, config-change-like destruction.
        crate::rclone::backend::saf_bridge::request_quit();
        match TAURI.get() {
            Some(app) => app.exit(code),
            None => std::process::exit(code),
        }
    }

    fn prepare(&self, _app: &CoreHandle, paths: &AppPaths) -> Result<(), String> {
        super::files::remove_temp_views(&paths.cache_dir);
        Ok(())
    }

    fn init_theme(&self) {
        super::theme::init_system_theme();
    }

    fn cleanup(&self) {
        super::files::remove_temp_views(&self.0.cache_dir);
    }

    #[cfg(feature = "tauri-plugin-notification")]
    fn notify(
        &self,
        ctx: &crate::services::alerts::template::TemplateContext,
    ) -> Result<(), String> {
        if crate::rclone::backend::saf_bridge::show_notification(&ctx.title, &ctx.body) {
            Ok(())
        } else {
            Err("Android notification bridge unavailable".into())
        }
    }
}

/// Starts the backend once per process; later calls return the running one.
fn start(
    data_dir: std::path::PathBuf,
    cache_dir: std::path::PathBuf,
) -> Result<CoreHandle, String> {
    let mut core = CORE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(core) = core.as_ref() {
        return Ok(core.clone());
    }
    let args = CliArgs::try_parse_from(["rclone-manager"]).map_err(|e| e.to_string())?;
    let paths = AppPaths {
        logs_dir: cache_dir.join("logs"),
        resource_dir: cache_dir.join("resources"),
        config_dir: data_dir,
        cache_dir,
    };
    let context = CoreHandle::new(Arc::new(AndroidHost(paths)), crate::app::PRODUCT);
    context.manage(args.general);
    rclone_manager_core::app::setup_context(&context, None).map_err(|e| e.to_string())?;
    *core = Some(context.clone());
    Ok(context)
}

fn running() -> Option<CoreHandle> {
    CORE.lock().unwrap_or_else(PoisonError::into_inner).clone()
}

/// Tauri's setup: joins the running backend (or starts it for a normal launch) and gives it
/// a window and an event channel to the page.
pub(crate) fn attach(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let context = start(app.path().app_data_dir()?, app.path().app_cache_dir()?)?;
    app.manage(context.clone());
    let _ = TAURI.set(app.clone());
    context
        .state::<Arc<crate::services::bridge::EventBridge>>()
        .set_sink(Arc::new(super::events::WebviewEventSink(app.clone())));
    log::debug!("Creating main window on mobile");
    tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default()).build()?;
    Ok(())
}

fn read_string(env: &mut jni::Env, value: jstring) -> String {
    unsafe { JString::from_raw(env, value) }
        .mutf8_chars(env)
        .map(Into::into)
        .unwrap_or_default()
}

/// Called by the boot service. No page is open, so the poller idles until one attaches.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_com_rclone_manager_RcloneSafBridge_nativeStartCore<'local>(
    mut env_unowned: EnvUnowned<'local>,
    _class: JClass<'local>,
    data_dir: jstring,
    cache_dir: jstring,
) {
    let _ = env_unowned.with_env(|env| {
        let data_dir = read_string(env, data_dir).into();
        let cache_dir = read_string(env, cache_dir).into();
        match start(data_dir, cache_dir) {
            Ok(core) => {
                let _ =
                    rclone_manager_core::rclone::engine::poller::set_poller_visibility(core, false);
            }
            Err(error) => log::error!("Failed to start the backend: {error}"),
        }
        Ok::<(), jni::errors::Error>(())
    });
}

/// Quit from the notification: the same graceful shutdown as the in-app quit.
/// Returns false when no backend runs, so Kotlin can end the process itself.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_com_rclone_manager_RcloneSafBridge_nativeQuit<'local>(
    _env: EnvUnowned<'local>,
    _class: JClass<'local>,
) -> jboolean {
    let Some(core) = running() else {
        return false;
    };
    crate::utils::spawn(async move {
        let _ = rclone_manager_core::services::lifecycle::shutdown::shutdown_app(core).await;
    });
    true
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn Java_com_rclone_manager_RcloneSafBridge_nativeStopAllJobs<'local>(
    _env: EnvUnowned<'local>,
    _class: JClass<'local>,
) {
    if let Some(core) = running() {
        crate::utils::spawn(
            rclone_manager_core::services::lifecycle::shutdown::stop_all_active_jobs_with_notice(
                core,
            ),
        );
    }
}
