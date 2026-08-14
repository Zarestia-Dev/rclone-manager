use log::info;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

#[cfg(all(desktop, target_os = "macos"))]
struct MacosActivityToken(
    objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>,
);

#[cfg(all(desktop, target_os = "macos"))]
unsafe impl Send for MacosActivityToken {}
#[cfg(all(desktop, target_os = "macos"))]
unsafe impl Sync for MacosActivityToken {}

pub struct PowerInhibitorState {
    is_inhibited: AtomicBool,
    #[cfg(all(desktop, target_os = "linux"))]
    linux_fd: tokio::sync::Mutex<Option<zbus::zvariant::OwnedFd>>,
    #[cfg(all(desktop, target_os = "macos"))]
    macos_activity: tokio::sync::Mutex<Option<MacosActivityToken>>,
    #[cfg(all(desktop, target_os = "windows"))]
    windows_hwnd: tokio::sync::Mutex<Option<isize>>,
}

impl Default for PowerInhibitorState {
    fn default() -> Self {
        Self::new()
    }
}

impl PowerInhibitorState {
    #[must_use]
    pub fn new() -> Self {
        Self {
            is_inhibited: AtomicBool::new(false),
            #[cfg(all(desktop, target_os = "linux"))]
            linux_fd: tokio::sync::Mutex::new(None),
            #[cfg(all(desktop, target_os = "macos"))]
            macos_activity: tokio::sync::Mutex::new(None),
            #[cfg(all(desktop, target_os = "windows"))]
            windows_hwnd: tokio::sync::Mutex::new(None),
        }
    }

    #[must_use]
    pub fn is_inhibited(&self) -> bool {
        self.is_inhibited.load(Ordering::Relaxed)
    }

    pub async fn acquire(&self, _app: &AppHandle, reason: &str) {
        if self
            .is_inhibited
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return;
        }

        info!("🔒 Acquiring system OS power/shutdown inhibitor lock: {reason}");

        #[cfg(desktop)]
        self.acquire_platform(_app, reason).await;
    }

    pub async fn release(&self) {
        if self
            .is_inhibited
            .compare_exchange(true, false, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return;
        }

        info!("🔓 Releasing system OS power/shutdown inhibitor lock...");

        #[cfg(desktop)]
        self.release_platform().await;
    }

    #[cfg(all(desktop, target_os = "linux"))]
    async fn acquire_platform(&self, _app: &AppHandle, reason: &str) {
        match zbus::Connection::system().await {
            Ok(connection) => {
                match zbus::Proxy::new(
                    &connection,
                    "org.freedesktop.login1",
                    "/org/freedesktop/login1",
                    "org.freedesktop.login1.Manager",
                )
                .await
                {
                    Ok(proxy) => {
                        match proxy
                            .call::<_, _, zbus::zvariant::OwnedFd>(
                                "Inhibit",
                                &("shutdown:sleep", "RClone Manager", reason, "block"),
                            )
                            .await
                        {
                            Ok(fd) => {
                                info!(
                                    "🔒 Linux systemd logind shutdown/sleep inhibitor lock acquired: {reason}"
                                );
                                *self.linux_fd.lock().await = Some(fd);

                                let proxy_clone = proxy.clone();
                                tauri::async_runtime::spawn(async move {
                                    if let Ok(mut sleep_stream) =
                                        proxy_clone.receive_signal("PrepareForSleep").await
                                    {
                                        use futures_lite::stream::StreamExt;
                                        while let Some(signal) = sleep_stream.next().await {
                                            if let Ok(true) = signal.body().deserialize::<bool>() {
                                                info!(
                                                    "⚠️ OS Sleep requested while power inhibitor is active"
                                                );
                                            }
                                        }
                                    }
                                });

                                tauri::async_runtime::spawn(async move {
                                    if let Ok(mut shutdown_stream) =
                                        proxy.receive_signal("PrepareForShutdown").await
                                    {
                                        use futures_lite::stream::StreamExt;
                                        while let Some(signal) = shutdown_stream.next().await {
                                            if let Ok(true) = signal.body().deserialize::<bool>() {
                                                info!(
                                                    "⚠️ OS Shutdown requested while power inhibitor is active"
                                                );
                                            }
                                        }
                                    }
                                });
                            }
                            Err(e) => {
                                log::error!("Failed to acquire systemd logind inhibitor lock: {e}");
                            }
                        }
                    }
                    Err(e) => log::error!("Failed to create login1 proxy: {e}"),
                }
            }
            Err(e) => log::error!("Failed to connect to system D-Bus: {e}"),
        }
    }

    #[cfg(all(desktop, target_os = "linux"))]
    async fn release_platform(&self) {
        if let Some(fd) = self.linux_fd.lock().await.take() {
            drop(fd);
            info!("🔓 Linux systemd logind shutdown/sleep inhibitor lock released");
        }
    }

    #[cfg(all(desktop, target_os = "windows"))]
    async fn acquire_platform(&self, app: &AppHandle, reason_str: &str) {
        use windows_sys::Win32::System::Power::{
            ES_AWAYMODE_REQUIRED, ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
        };

        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED);
        }

        let raw_hwnd = app
            .get_webview_window("main")
            .and_then(|window| window.hwnd().ok())
            .map(|hwnd| hwnd.0 as isize);

        if let Some(raw_hwnd) = raw_hwnd {
            let reason: Vec<u16> = reason_str
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();

            unsafe {
                windows_sys::Win32::System::Shutdown::ShutdownBlockReasonCreate(
                    raw_hwnd as _,
                    reason.as_ptr(),
                );
            }
            *self.windows_hwnd.lock().await = Some(raw_hwnd);
            info!("🔒 Windows shutdown block reason registered: {reason_str}");
        }
    }

    #[cfg(all(desktop, target_os = "windows"))]
    async fn release_platform(&self) {
        use windows_sys::Win32::System::Power::{ES_CONTINUOUS, SetThreadExecutionState};

        if let Some(hwnd) = self.windows_hwnd.lock().await.take() {
            unsafe {
                windows_sys::Win32::System::Shutdown::ShutdownBlockReasonDestroy(hwnd as _);
            }
            info!("🔓 Windows shutdown block reason destroyed");
        }

        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }

    #[cfg(all(desktop, target_os = "macos"))]
    async fn acquire_platform(&self, _app: &AppHandle, reason_str: &str) {
        use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

        let mut lock = self.macos_activity.lock().await;
        if lock.is_none() {
            let process_info = NSProcessInfo::processInfo();
            let options =
                NSActivityOptions::IdleSystemSleepDisabled | NSActivityOptions::UserInitiated;
            let reason = NSString::from_str(reason_str);
            let activity = process_info.beginActivityWithOptions_reason(options, &reason);
            info!(
                "🔒 macOS NSProcessInfo activity assertion lock acquired (Prevent System Sleep & App Nap): {reason_str}"
            );
            *lock = Some(MacosActivityToken(activity));
        }
    }

    #[cfg(all(desktop, target_os = "macos"))]
    async fn release_platform(&self) {
        use objc2_foundation::NSProcessInfo;

        let mut lock = self.macos_activity.lock().await;
        if let Some(token) = lock.take() {
            let process_info = NSProcessInfo::processInfo();
            unsafe {
                process_info.endActivity(&token.0);
            }
            info!("🔓 macOS NSProcessInfo activity assertion lock released");
        }
    }

    #[cfg(all(
        desktop,
        not(any(target_os = "linux", target_os = "windows", target_os = "macos"))
    ))]
    async fn acquire_platform(&self, _app: &AppHandle, _reason: &str) {}

    #[cfg(all(
        desktop,
        not(any(target_os = "linux", target_os = "windows", target_os = "macos"))
    ))]
    async fn release_platform(&self) {}
}

fn get_localized_inhibitor_reason(
    mounts_count: usize,
    jobs_count: usize,
    serves_count: usize,
) -> String {
    use crate::utils::i18n::{t, t_with_params};

    let mut parts = Vec::new();
    if mounts_count > 0 {
        parts.push(t_with_params(
            "powerInhibitor.mounts",
            &[("count", &mounts_count.to_string())],
        ));
    }
    if jobs_count > 0 {
        parts.push(t_with_params(
            "powerInhibitor.jobs",
            &[("count", &jobs_count.to_string())],
        ));
    }
    if serves_count > 0 {
        parts.push(t_with_params(
            "powerInhibitor.serves",
            &[("count", &serves_count.to_string())],
        ));
    }

    if parts.is_empty() {
        t("notification.body.powerInhibited")
    } else {
        let details = parts.join(", ");
        t_with_params("powerInhibitor.reason", &[("details", &details)])
    }
}

pub async fn update_power_inhibition(app: &AppHandle) {
    let settings_manager = app.try_state::<crate::core::settings::AppSettingsManager>();
    let prevent_sleep_enabled = settings_manager
        .and_then(|m| m.get_all().ok())
        .map(|s| s.general.prevent_sleep)
        .unwrap_or(true);

    let backend_manager = app.try_state::<crate::rclone::backend::BackendManager>();
    let (has_active_operations, mounts_count, jobs_count, serves_count) =
        if let Some(bm) = backend_manager {
            let active_jobs = bm.job_cache.get_active_jobs().await;
            let active_mounts = bm.remote_cache.get_mounted_remotes().await;
            let active_serves = bm.remote_cache.get_serves().await;

            let j_count = active_jobs.len();
            let m_count = active_mounts.len();
            let s_count = active_serves.len();

            let active = j_count > 0 || m_count > 0 || s_count > 0;
            (active, m_count, j_count, s_count)
        } else {
            (false, 0, 0, 0)
        };

    if let Some(state) = app.try_state::<PowerInhibitorState>() {
        if prevent_sleep_enabled && has_active_operations {
            let reason = get_localized_inhibitor_reason(mounts_count, jobs_count, serves_count);
            state.acquire(app, &reason).await;
        } else if state.is_inhibited() {
            state.release().await;
        }
    }
}
