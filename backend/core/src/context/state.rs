use parking_lot::RwLock;
use std::{
    any::{Any, TypeId},
    collections::HashMap,
    ops::Deref,
    sync::Arc,
};

#[derive(Clone)]
/// Shared application state and process lifecycle. Hosts construct this once and
/// pass clones to adapters; cloning does not copy registered services.
pub struct AppHandle {
    host: Arc<dyn super::Host>,
    product: super::ProductInfo,
    states: Arc<RwLock<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>>,
    exit: tokio::sync::watch::Sender<Option<i32>>,
}

impl Default for AppHandle {
    fn default() -> Self {
        Self::new(super::host::unconfigured(), super::ProductInfo::default())
    }
}

/// Owned reference to a registered service, independent of the context borrow.
pub struct State<T> {
    value: Arc<T>,
}

impl<T> Clone for State<T> {
    fn clone(&self) -> Self {
        Self {
            value: self.value.clone(),
        }
    }
}

impl<T> State<T> {
    pub fn inner(&self) -> &T {
        &self.value
    }
}

impl<T> Deref for State<T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.inner()
    }
}

impl AppHandle {
    /// Access a service registered during startup. Missing services are a
    /// programming error; optional integrations must use `try_state` instead.
    pub fn state<T: Send + Sync + 'static>(&self) -> State<T> {
        self.try_state().unwrap_or_else(|| {
            panic!(
                "Unregistered application state: {}",
                std::any::type_name::<T>()
            )
        })
    }
    /// Register a service once. Returns false without replacing an existing value.
    pub fn manage<T: Send + Sync + 'static>(&self, value: T) -> bool {
        let mut states = self.states.write();
        if let std::collections::hash_map::Entry::Vacant(entry) = states.entry(TypeId::of::<T>()) {
            entry.insert(Arc::new(value));
            true
        } else {
            false
        }
    }

    pub fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<T>> {
        self.states
            .read()
            .get(&TypeId::of::<T>())
            .cloned()
            .and_then(|value| value.downcast().ok())
            .map(|value| State { value })
    }
}

impl AppHandle {
    pub fn new(host: Arc<dyn super::Host>, product: super::ProductInfo) -> Self {
        Self {
            host,
            product,
            states: Arc::default(),
            exit: tokio::sync::watch::channel(None).0,
        }
    }
    pub fn product(&self) -> &super::ProductInfo {
        &self.product
    }
    pub fn host(&self) -> &dyn super::Host {
        self.host.as_ref()
    }
    pub fn exit(&self, code: i32) {
        let first = self.exit.send_if_modified(|current| {
            if current.is_some() {
                false
            } else {
                *current = Some(code);
                true
            }
        });
        if first {
            self.host.exit(code);
        }
    }

    pub async fn wait_for_exit(&self) -> i32 {
        let mut receiver = self.exit.subscribe();
        loop {
            if let Some(code) = *receiver.borrow_and_update() {
                return code;
            }
            receiver
                .changed()
                .await
                .expect("Application owns exit sender");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct ExitHost(std::sync::atomic::AtomicUsize);
    #[async_trait::async_trait]
    impl super::super::Host for ExitHost {
        fn resolve_paths(
            &self,
            _app: &AppHandle,
        ) -> Result<crate::services::paths::AppPaths, String> {
            Err("unused".into())
        }
        fn restart(&self, _app: &AppHandle) -> Result<(), String> {
            Err("unused".into())
        }
        fn exit(&self, _code: i32) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn host_exit_runs_once_across_context_clones() {
        let host = Arc::new(ExitHost(std::sync::atomic::AtomicUsize::new(0)));
        let app = AppHandle::new(
            host.clone(),
            super::super::ProductInfo {
                display_name: "Test product",
                release_prefix: "test-v",
                ..Default::default()
            },
        );
        assert_eq!(app.clone().product().display_name, "Test product");
        assert_eq!(app.clone().product().release_prefix, "test-v");
        app.clone().exit(7);
        app.exit(0);
        assert_eq!(app.wait_for_exit().await, 7);
        assert_eq!(host.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    #[test]
    #[cfg(all(target_os = "windows", feature = "desktop"))]
    fn headless_host_has_no_native_window() {
        assert_eq!(AppHandle::default().host().main_window_hwnd(), None);
    }
    #[test]
    fn headless_host_does_not_request_native_exit_confirmation() {
        let app = AppHandle::default();
        assert_eq!(
            app.host()
                .confirm_exit(crate::utils::app::platform::ActiveOperationsSummary {
                    has_active_operations: true,
                    active_jobs_count: 1,
                    active_mounts_count: 1,
                    active_serves_count: 1,
                }),
            super::super::ExitDecision::Proceed
        );
    }
    #[test]
    fn state_is_shared_and_duplicate_registration_preserves_value() {
        let app = AppHandle::default();
        assert!(app.try_state::<String>().is_none());
        assert!(app.manage(String::from("original")));
        let clone = app.clone();
        assert!(!clone.manage(String::from("replacement")));
        assert_eq!(clone.state::<String>().inner(), "original");
        assert!(app.manage(42_u32));
        assert_eq!(*app.state::<u32>(), 42);
    }
    #[test]
    fn owned_state_survives_context_and_other_handles() {
        let state = {
            let app = AppHandle::default();
            app.manage(parking_lot::Mutex::new(String::from("original")));
            app.state::<parking_lot::Mutex<String>>()
        };
        let other = state.clone();
        *other.lock() = String::from("updated");
        drop(other);
        assert_eq!(*state.lock(), "updated");
    }
    #[test]
    #[should_panic(expected = "Unregistered application state")]
    fn missing_state_is_explicit() {
        AppHandle::default().state::<String>();
    }
    #[tokio::test]
    async fn exit_before_wait_is_retained_and_first_exit_wins() {
        let app = AppHandle::default();
        app.exit(7);
        app.clone().exit(0);
        assert_eq!(app.wait_for_exit().await, 7);
    }
    #[tokio::test]
    async fn exit_wakes_waiter() {
        let app = AppHandle::default();
        let clone = app.clone();
        let task = crate::utils::spawn(async move { clone.wait_for_exit().await });
        tokio::task::yield_now().await;
        app.exit(0);
        assert_eq!(task.await.unwrap(), 0);
    }
}
