//! Shared D-Bus connections. A zbus connection owns a socket and background tasks, so the
//! app opens one per bus and every client uses that one.
use tokio::sync::OnceCell;
use zbus::Connection;

static SESSION: OnceCell<Connection> = OnceCell::const_new();
static SYSTEM: OnceCell<Connection> = OnceCell::const_new();

/// The session bus. A failed attempt is not remembered, so the next call tries again.
pub async fn session() -> zbus::Result<&'static Connection> {
    SESSION.get_or_try_init(Connection::session).await
}

/// The system bus. A failed attempt is not remembered, so the next call tries again.
pub async fn system() -> zbus::Result<&'static Connection> {
    SYSTEM.get_or_try_init(Connection::system).await
}

/// systemd-logind's manager, which inhibits idle, suspends and powers off.
pub async fn login1() -> zbus::Result<zbus::Proxy<'static>> {
    zbus::Proxy::new(
        system().await?,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )
    .await
}
