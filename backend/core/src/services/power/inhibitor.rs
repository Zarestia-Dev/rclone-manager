use crate::context::AppHandle;
use log::info;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "macos")]
struct MacosActivityToken(
    objc2::rc::Retained<objc2::runtime::ProtocolObject<dyn objc2_foundation::NSObjectProtocol>>,
);

#[cfg(target_os = "macos")]
unsafe impl Send for MacosActivityToken {}
#[cfg(target_os = "macos")]
unsafe impl Sync for MacosActivityToken {}

/// What a Linux acquire holds: the logind lock (released when its file descriptor closes,
/// which is `None` when logind refused) and the guard that stops the shutdown watcher.
#[cfg(target_os = "linux")]
struct LinuxInhibit {
    fd: Option<zbus::OwnedFd>,
    _stop_watching: tokio_util::sync::DropGuard,
}

pub struct PowerInhibitorState {
    /// Written only while `turn` is held; read without it.
    is_inhibited: AtomicBool,
    /// One acquire or release at a time, so the flag and the platform lock never disagree.
    turn: tokio::sync::Mutex<()>,
    #[cfg(target_os = "linux")]
    linux: tokio::sync::Mutex<Option<LinuxInhibit>>,
    #[cfg(target_os = "macos")]
    macos_activity: tokio::sync::Mutex<Option<MacosActivityToken>>,
    #[cfg(target_os = "windows")]
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
            turn: tokio::sync::Mutex::new(()),
            #[cfg(target_os = "linux")]
            linux: tokio::sync::Mutex::new(None),
            #[cfg(target_os = "macos")]
            macos_activity: tokio::sync::Mutex::new(None),
            #[cfg(target_os = "windows")]
            windows_hwnd: tokio::sync::Mutex::new(None),
        }
    }

    #[must_use]
    pub fn is_inhibited(&self) -> bool {
        self.is_inhibited.load(Ordering::Acquire)
    }

    pub async fn acquire(&self, _app: &AppHandle, reason: &str) {
        let _turn = self.turn.lock().await;
        if self.is_inhibited.swap(true, Ordering::Release) {
            return;
        }

        info!("🔒 Acquiring system OS power inhibitor lock: {reason}");
        self.acquire_platform(_app, reason).await;
    }

    pub async fn release(&self) {
        let _turn = self.turn.lock().await;
        if !self.is_inhibited.swap(false, Ordering::Release) {
            return;
        }

        info!("🔓 Releasing system OS power inhibitor lock...");
        self.release_platform().await;
    }

    #[cfg(target_os = "linux")]
    async fn acquire_platform(&self, app: &AppHandle, reason: &str) {
        let mut held = self.linux.lock().await;
        let proxy = match crate::utils::dbus::login1().await {
            Ok(proxy) => proxy,
            Err(e) => {
                log::debug!("System D-Bus unavailable for power inhibitor: {e}");
                return;
            }
        };

        // Inhibit "idle" to prevent automatic system sleep/suspend while operations run.
        // Unlike "sleep" and "shutdown", inhibiting "idle":
        // 1. Prevents unattended idle suspend during long transfers.
        // 2. Does not prompt for Polkit/root passwords on manual sleep.
        // 3. Allows clean desktop shutdown/reboot without black-screen hangs on KDE Plasma 6.
        // 4. Safely allows laptops to suspend when the lid is closed to prevent overheating in bags.
        let fd = match proxy
            .call::<_, _, zbus::OwnedFd>("Inhibit", &("idle", "RClone Manager", reason, "block"))
            .await
        {
            Ok(fd) => {
                info!("🔒 Linux systemd logind idle inhibitor lock acquired: {reason}");
                Some(fd)
            }
            Err(e) => {
                log::debug!("Failed to acquire systemd logind idle inhibitor lock: {e}");
                None
            }
        };

        let stop = tokio_util::sync::CancellationToken::new();
        crate::utils::spawn(unmount_on_os_shutdown(app.clone(), proxy, stop.clone()));
        *held = Some(LinuxInhibit {
            fd,
            _stop_watching: stop.drop_guard(),
        });
    }

    #[cfg(target_os = "linux")]
    async fn release_platform(&self) {
        // Dropping it closes the descriptor and stops the shutdown watcher.
        if let Some(inhibit) = self.linux.lock().await.take()
            && inhibit.fd.is_some()
        {
            info!("🔓 Linux systemd logind idle inhibitor lock released");
        }
    }

    #[cfg(target_os = "windows")]
    async fn acquire_platform(&self, app: &AppHandle, reason_str: &str) {
        use windows_sys::Win32::System::Power::{
            ES_AWAYMODE_REQUIRED, ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
        };

        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED);
        }

        let raw_hwnd = app.host().main_window_hwnd();

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

    #[cfg(target_os = "windows")]
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

    #[cfg(target_os = "macos")]
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

    #[cfg(target_os = "macos")]
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

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    async fn acquire_platform(&self, _app: &AppHandle, _reason: &str) {}

    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    async fn release_platform(&self) {}
}

/// While the inhibitor is held, unmounts the remotes when the OS announces a shutdown. It
/// ends when `stop` is cancelled, which only takes effect between signals: the shutdown
/// itself releases the inhibitor and must not be cut off.
#[cfg(target_os = "linux")]
async fn unmount_on_os_shutdown(
    app: AppHandle,
    logind: zbus::Proxy<'static>,
    stop: tokio_util::sync::CancellationToken,
) {
    use futures::StreamExt;

    let Ok(mut signals) = logind.receive_signal("PrepareForShutdown").await else {
        return;
    };
    loop {
        let signal = tokio::select! {
            () = stop.cancelled() => return,
            signal = signals.next() => signal,
        };
        let Some(signal) = signal else {
            return;
        };
        if !matches!(signal.body().deserialize::<bool>(), Ok(true)) {
            continue;
        }
        info!("⚠️ OS Shutdown requested while power inhibitor is active; unmounting remotes");

        let is_already_shutting_down = app
            .try_state::<crate::utils::types::state::RcloneState>()
            .is_some_and(|s| s.is_shutting_down());
        if !is_already_shutting_down {
            crate::services::lifecycle::shutdown::handle_shutdown(app.clone()).await;
        }

        if let Some(state) = app.try_state::<PowerInhibitorState>() {
            state.release().await;
        }
    }
}

fn get_localized_inhibitor_reason(
    mounts_count: usize,
    jobs_count: usize,
    serves_count: usize,
) -> String {
    use crate::utils::i18n::{t, t_with_params};

    let parts =
        crate::utils::i18n::localized_operation_counts(mounts_count, jobs_count, serves_count);
    if parts.is_empty() {
        t("notification.body.powerInhibited")
    } else {
        let details = parts.join(", ");
        t_with_params("powerInhibitor.reason", &[("details", &details)])
    }
}

pub async fn update_power_inhibition(app: &AppHandle) {
    if app
        .try_state::<crate::utils::types::state::RcloneState>()
        .is_some_and(|s| s.is_shutting_down())
    {
        return;
    }

    let prevent_sleep_enabled = app
        .try_state::<crate::services::settings::AppSettingsManager>()
        .and_then(|manager| manager.get::<bool>("general.prevent_sleep").ok())
        .unwrap_or(true);

    let backend_manager = app.try_state::<crate::rclone::backend::BackendManager>();
    let (has_active_operations, mounts_count, jobs_count, serves_count) =
        if let Some(bm) = backend_manager {
            let (j_count, m_count, s_count) = bm.active_operation_counts().await;

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
