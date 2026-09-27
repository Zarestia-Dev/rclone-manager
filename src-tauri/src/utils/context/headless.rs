use parking_lot::RwLock;
use std::{
    any::{Any, TypeId},
    collections::HashMap,
    marker::PhantomData,
    ops::Deref,
    sync::Arc,
};

#[derive(Clone)]
pub struct AppHandle {
    states: Arc<RwLock<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>>,
    exit: tokio::sync::watch::Sender<Option<i32>>,
}

impl Default for AppHandle {
    fn default() -> Self {
        Self {
            states: Arc::default(),
            exit: tokio::sync::watch::channel(None).0,
        }
    }
}

pub struct State<'a, T> {
    value: Arc<T>,
    lifetime: PhantomData<&'a T>,
}

impl<T> Clone for State<'_, T> {
    fn clone(&self) -> Self {
        Self {
            value: self.value.clone(),
            lifetime: PhantomData,
        }
    }
}

impl<T> State<'_, T> {
    pub fn inner(&self) -> &T {
        &self.value
    }
}

impl<T> Deref for State<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.inner()
    }
}

pub trait Manager {
    fn manage<T: Send + Sync + 'static>(&self, value: T) -> bool;
    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>>;
    fn state<T: Send + Sync + 'static>(&self) -> State<'_, T> {
        self.try_state().unwrap_or_else(|| {
            panic!(
                "Unregistered application state: {}",
                std::any::type_name::<T>()
            )
        })
    }
}

impl Manager for AppHandle {
    fn manage<T: Send + Sync + 'static>(&self, value: T) -> bool {
        let mut states = self.states.write();
        if let std::collections::hash_map::Entry::Vacant(entry) = states.entry(TypeId::of::<T>()) {
            entry.insert(Arc::new(value));
            true
        } else {
            false
        }
    }

    fn try_state<T: Send + Sync + 'static>(&self) -> Option<State<'_, T>> {
        self.states
            .read()
            .get(&TypeId::of::<T>())
            .cloned()
            .and_then(|value| value.downcast().ok())
            .map(|value| State {
                value,
                lifetime: PhantomData,
            })
    }
}

impl AppHandle {
    pub fn exit(&self, code: i32) {
        self.exit.send_if_modified(|current| {
            if current.is_some() {
                false
            } else {
                *current = Some(code);
                true
            }
        });
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
