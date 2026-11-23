//! The server's tray. Core builds and updates it; this module gives it a thread to
//! live on, since the server runs no UI event loop. On Linux the tray talks to the
//! desktop over D-Bus, on Windows this thread also pumps the tray window's messages.
//! macOS draws a tray only on the main thread, which the server keeps for its
//! runtime, so a macOS server shows none.
use rclone_manager_core::context::AppHandle;
use rclone_manager_core::services::tray::{TrayMenuState, actions::TrayView, native};
use std::sync::{OnceLock, mpsc};

type Task = Box<dyn FnOnce() + Send>;

/// Where the tray's entries open the web UI: its origin only, not the HTTP
/// options, which hold the password.
static WEB_UI: OnceLock<String> = OnceLock::new();

/// Lets core show the tray. Call before startup.
pub(super) fn init(app: &AppHandle, http: &crate::HttpArgs) {
    let _ = WEB_UI.set(http.web_ui_url(""));
    app.manage(TrayMenuState::default());
    native::handle_menu_events(app);
}

pub(super) fn open_view(view: TrayView<'_>) {
    let path = match view {
        TrayView::Main => String::new(),
        TrayView::FileBrowser(None) => "/nautilus".to_string(),
        TrayView::FileBrowser(Some(remote)) => format!(
            "/nautilus/{}",
            percent_encoding::utf8_percent_encode(remote, percent_encoding::NON_ALPHANUMERIC)
        ),
    };
    let Some(url) = WEB_UI.get().map(|origin| format!("{origin}{path}")) else {
        return;
    };
    if let Err(error) = open::that_detached(&url) {
        log::error!("Failed to open web UI ({url}): {error}");
    }
}

/// Runs `task` on the tray thread, starting it the first time.
pub(super) fn run(task: Task) -> Result<(), String> {
    static THREAD: OnceLock<Result<TrayThread, String>> = OnceLock::new();
    THREAD
        .get_or_init(TrayThread::spawn)
        .as_ref()
        .map_err(Clone::clone)?
        .send(task)
}

struct TrayThread {
    tasks: mpsc::Sender<Task>,
    /// Woken with a thread message after each task, because it waits for messages.
    #[cfg(windows)]
    id: u32,
}

impl TrayThread {
    fn spawn() -> Result<Self, String> {
        let (tasks, queue) = mpsc::channel::<Task>();
        let (ready, started) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("tray".into())
            .spawn(move || work(queue, ready))
            .map_err(|error| error.to_string())?;
        let _id = started
            .recv()
            .map_err(|_| "The tray thread failed to start".to_string())?;
        Ok(Self {
            tasks,
            #[cfg(windows)]
            id: _id,
        })
    }

    fn send(&self, task: Task) -> Result<(), String> {
        self.tasks
            .send(task)
            .map_err(|_| "The tray thread has stopped".to_string())?;
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_APP};
            // SAFETY: the message carries no pointers.
            if unsafe { PostThreadMessageW(self.id, WM_APP, 0, 0) } == 0 {
                log::warn!("Failed to wake the tray thread; the change waits for its next message");
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
fn work(queue: mpsc::Receiver<Task>, ready: mpsc::SyncSender<u32>) {
    if ready.send(0).is_ok() {
        for task in queue {
            task();
        }
    }
}

#[cfg(windows)]
fn work(queue: mpsc::Receiver<Task>, ready: mpsc::SyncSender<u32>) {
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, MSG, PM_NOREMOVE, PeekMessageW, TranslateMessage, WM_USER,
    };
    // SAFETY: `msg` is a valid, writable MSG for every call; a null window means
    // this thread's own messages.
    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        // Creates this thread's message queue before anyone posts to it.
        PeekMessageW(
            &mut msg,
            std::ptr::null_mut(),
            WM_USER,
            WM_USER,
            PM_NOREMOVE,
        );
        if ready.send(GetCurrentThreadId()).is_err() {
            return;
        }
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
            // Checked after every message: an open tray menu runs its own loop, which
            // drops the wake-up, and tray-icon posts a message when the menu closes.
            while let Ok(task) = queue.try_recv() {
                task();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tasks_run_in_order_on_one_thread_of_their_own() {
        let (done, results) = mpsc::channel();
        for index in 0..20 {
            let done = done.clone();
            run(Box::new(move || {
                let _ = done.send((index, std::thread::current().id()));
            }))
            .unwrap();
        }
        let received: Vec<_> = (0..20).map(|_| results.recv().unwrap()).collect();
        assert_eq!(
            received.iter().map(|(index, _)| *index).collect::<Vec<_>>(),
            (0..20).collect::<Vec<_>>()
        );
        let tray_thread = received[0].1;
        assert_ne!(tray_thread, std::thread::current().id());
        assert!(received.iter().all(|(_, thread)| *thread == tray_thread));
    }
}
