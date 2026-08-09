use log::{error, info};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

pub struct PowerInhibitorState {
    is_inhibited: AtomicBool,
    #[cfg(all(desktop, target_os = "linux"))]
    linux_fd: tokio::sync::Mutex<Option<zbus::zvariant::OwnedFd>>,
    #[cfg(all(desktop, target_os = "macos"))]
    macos_activity: tokio::sync::Mutex<Option<objc2::rc::Retained<objc2_foundation::NSObject>>>,
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
    #[allow(dead_code)]
    pub fn is_inhibited(&self) -> bool {
        self.is_inhibited.load(Ordering::Relaxed)
    }

    pub async fn acquire(&self, _app: &AppHandle) {
        if self
            .is_inhibited
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return;
        }

        info!("🔒 Acquiring system OS power/shutdown inhibitor lock...");

        #[cfg(target_os = "linux")]
        {
            self.acquire_linux().await;
        }

        #[cfg(target_os = "windows")]
        {
            self.acquire_windows(_app).await;
        }

        #[cfg(target_os = "macos")]
        {
            self.acquire_macos().await;
        }
    }

    pub async fn release(&self, _app: &AppHandle) {
        if self
            .is_inhibited
            .compare_exchange(true, false, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            return;
        }

        info!("🔓 Releasing system OS power/shutdown inhibitor lock...");

        #[cfg(target_os = "linux")]
        {
            self.release_linux().await;
        }

        #[cfg(target_os = "windows")]
        {
            self.release_windows().await;
        }

        #[cfg(target_os = "macos")]
        {
            self.release_macos().await;
        }
    }

    #[cfg(all(desktop, target_os = "linux"))]
    async fn acquire_linux(&self) {
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
                                &(
                                    "shutdown:sleep",
                                    "Rclone Manager",
                                    "Active file transfer jobs in progress",
                                    "block",
                                ),
                            )
                            .await
                        {
                            Ok(fd) => {
                                info!(
                                    "🔒 Linux systemd logind shutdown/sleep inhibitor lock acquired"
                                );
                                *self.linux_fd.lock().await = Some(fd);
                            }
                            Err(e) => {
                                error!("Failed to acquire systemd logind inhibitor lock: {e}");
                            }
                        }
                    }
                    Err(e) => error!("Failed to create login1 proxy: {e}"),
                }
            }
            Err(e) => error!("Failed to connect to system D-Bus: {e}"),
        }
    }

    #[cfg(all(desktop, target_os = "linux"))]
    async fn release_linux(&self) {
        if let Some(fd) = self.linux_fd.lock().await.take() {
            drop(fd);
            info!("🔓 Linux systemd logind shutdown/sleep inhibitor lock released");
        }
    }

    #[cfg(all(desktop, target_os = "windows"))]
    async fn acquire_windows(&self, app: &AppHandle) {
        use windows_sys::Win32::System::Threading::{
            ES_AWAYMODE_REQUIRED, ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
        };

        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED);
        }

        if let Some(window) = app.get_webview_window("main")
            && let Ok(hwnd) = window.hwnd()
        {
            let raw_hwnd = hwnd.0 as isize;
            let reason: Vec<u16> =
                "Rclone Manager is currently executing background file transfers."
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
            info!("🔒 Windows shutdown block reason registered");
        }
    }

    #[cfg(all(desktop, target_os = "windows"))]
    async fn release_windows(&self) {
        use windows_sys::Win32::System::Threading::{ES_CONTINUOUS, SetThreadExecutionState};

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
    async fn acquire_macos(&self) {
        use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

        let process_info = NSProcessInfo::processInfo();
        let options = NSActivityOptions::IdleSystemSleepDisabled | NSActivityOptions::UserInitiated;
        let reason = NSString::from_str("Active file transfer jobs in progress");

        let activity = unsafe { process_info.beginActivityWithOptions_reason(options, &reason) };
        info!(
            "🔒 macOS NSProcessInfo activity assertion lock acquired (Prevent System Sleep & App Nap)"
        );
        *self.macos_activity.lock().await = Some(activity);
    }

    #[cfg(all(desktop, target_os = "macos"))]
    async fn release_macos(&self) {
        use objc2_foundation::NSProcessInfo;

        if let Some(activity) = self.macos_activity.lock().await.take() {
            let process_info = NSProcessInfo::processInfo();
            unsafe {
                process_info.endActivity(&activity);
            }
            info!("🔓 macOS NSProcessInfo activity assertion lock released");
        }
    }
}

pub async fn update_power_inhibition(app: &AppHandle) {
    let settings_manager = app.try_state::<crate::core::settings::AppSettingsManager>();
    let prevent_sleep_enabled = settings_manager
        .and_then(|m| m.get_all().ok())
        .map(|s| s.general.prevent_sleep)
        .unwrap_or(true);

    let backend_manager = app.try_state::<crate::rclone::backend::BackendManager>();
    let has_active_operations = if let Some(bm) = backend_manager {
        let has_jobs = bm.job_cache.has_running_jobs().await;
        let has_mounts = !bm.remote_cache.get_mounted_remotes().await.is_empty();
        let has_serves = !bm.remote_cache.get_serves().await.is_empty();
        has_jobs || has_mounts || has_serves
    } else {
        false
    };

    if let Some(state) = app.try_state::<PowerInhibitorState>() {
        if prevent_sleep_enabled && has_active_operations {
            state.acquire(app).await;
        } else {
            state.release(app).await;
        }
    }
}
