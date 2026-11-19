//! The XDG settings portal, shared by the Linux watchers (theme, window button layout).
use futures::Stream;
use tokio::sync::OnceCell;

static SETTINGS: OnceCell<zbus::Proxy<'static>> = OnceCell::const_new();

/// The portal's settings interface on the shared session bus connection; `None` when there
/// is no session bus or no portal. A failed attempt is not remembered.
pub(super) async fn settings() -> Option<&'static zbus::Proxy<'static>> {
    SETTINGS
        .get_or_try_init(|| async {
            zbus::Proxy::new(
                crate::utils::dbus::session().await?,
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.Settings",
            )
            .await
        })
        .await
        .inspect_err(|e| log::debug!("No settings portal: {e}"))
        .ok()
}

/// A `SettingChanged` signal for one setting. The bus filters on the namespace and key, so
/// other settings never wake the watcher.
pub(super) async fn setting_changes(
    namespace: &'static str,
    key: &'static str,
) -> Option<impl Stream<Item = zbus::Message>> {
    settings()
        .await?
        .receive_signal_with_args("SettingChanged", &[(0, namespace), (1, key)])
        .await
        .inspect_err(|e| log::debug!("Cannot follow portal setting {namespace}/{key}: {e}"))
        .ok()
}

/// The new value in a `SettingChanged` signal.
pub(super) fn changed_value(message: &zbus::Message) -> Option<zbus::OwnedVariant> {
    let (_, _, value) = message
        .body()
        .deserialize::<(String, String, zbus::OwnedVariant)>()
        .ok()?;
    Some(value)
}
