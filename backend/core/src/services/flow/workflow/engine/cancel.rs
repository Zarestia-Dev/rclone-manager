//! Cancellation shared by a run and everything it starts.

use std::sync::Arc;
use std::time::Duration;

/// Cancellation shared by a run and every task it starts.
#[derive(Clone)]
pub(crate) struct CancelToken {
    pub(crate) tx: Arc<tokio::sync::watch::Sender<bool>>,
    pub(crate) rx: tokio::sync::watch::Receiver<bool>,
}

impl CancelToken {
    pub(crate) fn new() -> Self {
        let (tx, rx) = tokio::sync::watch::channel(false);
        Self {
            tx: Arc::new(tx),
            rx,
        }
    }

    pub(crate) fn cancel(&self) {
        self.tx.send_replace(true);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        *self.rx.borrow()
    }

    /// Resolves once cancelled, immediately if it already was.
    pub(crate) async fn cancelled(&self) {
        // The sender lives in this token, so waiting can only end by cancellation.
        let _ = self.rx.clone().wait_for(|cancelled| *cancelled).await;
    }
}

/// Sleeps for `duration`. Returns `false` when cancelled first.
pub(crate) async fn sleep_unless_cancelled(cancel: &CancelToken, duration: Duration) -> bool {
    tokio::select! {
        biased;
        () = cancel.cancelled() => false,
        () = tokio::time::sleep(duration) => true,
    }
}
