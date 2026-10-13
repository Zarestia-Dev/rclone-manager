use crate::core::alerts::{
    dispatch::{DispatchContext, run_with_retry},
    template::TemplateContext,
    types::MqttAction,
};
use log::debug;
use rumqttc::{
    Transport,
    v5::{AsyncClient, Event, EventLoop, MqttOptions, mqttbytes::QoS, mqttbytes::v5::Packet},
};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct MqttConnectionKey {
    action_id: String,
    host: String,
    port: u16,
    use_tls: bool,
    username: String,
    password: String,
}

impl MqttConnectionKey {
    fn from_action(action: &MqttAction) -> Self {
        Self {
            action_id: action.common.id.clone(),
            host: action.host.clone(),
            port: action.port,
            use_tls: action.use_tls,
            username: action.username.clone(),
            password: action.password.clone(),
        }
    }

    fn action_id(&self) -> &str {
        &self.action_id
    }
}

struct MqttConnectionEntry {
    session: Arc<MqttSession>,
    action_name: String,
}

#[derive(Default)]
pub struct MqttConnectionRegistry {
    sessions: RwLock<HashMap<MqttConnectionKey, Arc<MqttConnectionEntry>>>,
}

impl MqttConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get_or_create(
        &self,
        key: MqttConnectionKey,
        action_name: String,
        opts: MqttOptions,
    ) -> Arc<MqttSession> {
        {
            let sessions = self.sessions.read().await;
            if let Some(entry) = sessions.get(&key) {
                return entry.session.clone();
            }
        }

        let mut sessions = self.sessions.write().await;
        if let Some(entry) = sessions.get(&key) {
            return entry.session.clone();
        }

        let session = Arc::new(MqttSession::new(opts));
        let entry = Arc::new(MqttConnectionEntry {
            session: session.clone(),
            action_name: action_name.clone(),
        });
        log::debug!(
            "MQTT session created for action '{}' at {}:{}",
            action_name,
            key.host,
            key.port
        );
        sessions.insert(key, entry);
        session
    }

    pub async fn invalidate(&self, key: &MqttConnectionKey) {
        let mut sessions = self.sessions.write().await;
        if let Some(entry) = sessions.remove(key) {
            log::debug!(
                "MQTT session invalidated for action '{}' at {}:{}",
                entry.action_name,
                key.host,
                key.port
            );
        }
    }

    pub async fn prune_to_action_ids(&self, active_action_ids: &HashSet<String>) {
        let mut sessions = self.sessions.write().await;
        sessions.retain(|key, entry| {
            let keep = active_action_ids.contains(key.action_id());
            if !keep {
                log::debug!(
                    "MQTT session pruned for action '{}' at {}:{}",
                    entry.action_name,
                    key.host,
                    key.port
                );
            }
            keep
        });
    }
}

struct SessionState {
    eventloop: EventLoop,
    connected: bool,
}

pub struct MqttSession {
    client: AsyncClient,
    state: Mutex<SessionState>,
}

impl MqttSession {
    fn new(opts: MqttOptions) -> Self {
        let (client, eventloop) = AsyncClient::new(opts, 10);
        Self {
            client,
            state: Mutex::new(SessionState {
                eventloop,
                connected: false,
            }),
        }
    }

    async fn publish(
        &self,
        topic: &str,
        qos: QoS,
        retain: bool,
        payload: &str,
        timeout: Duration,
    ) -> Result<(), MqttError> {
        tokio::time::timeout(
            timeout,
            self.publish_inner(topic, qos, retain, payload.to_string()),
        )
        .await
        .map_err(|_| MqttError::Timeout(timeout))?
    }

    async fn publish_inner(
        &self,
        topic: &str,
        qos: QoS,
        retain: bool,
        payload: String,
    ) -> Result<(), MqttError> {
        let mut state = self.state.lock().await;

        if !state.connected {
            wait_for_connack(&mut state.eventloop).await?;
            state.connected = true;
        }

        self.client
            .publish(topic, qos, retain, payload)
            .await
            .map_err(|e| MqttError::Publish(e.to_string()))?;

        if qos == QoS::AtMostOnce {
            // Drive the eventloop once so the queued PUBLISH packet gets flushed.
            poll_once(&mut state.eventloop).await?;
            return Ok(());
        }

        loop {
            match state.eventloop.poll().await {
                Ok(Event::Incoming(Packet::PubAck(_) | Packet::PubRec(_) | Packet::PubComp(_))) => {
                    return Ok(());
                }
                Ok(Event::Incoming(Packet::ConnAck(_))) => {
                    state.connected = true;
                }
                Ok(_) => {}
                Err(e) => {
                    state.connected = false;
                    return Err(MqttError::Connection(e.to_string()));
                }
            }
        }
    }
}

async fn wait_for_connack(eventloop: &mut EventLoop) -> Result<(), MqttError> {
    loop {
        match eventloop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(_))) => return Ok(()),
            Ok(_) => {}
            Err(e) => return Err(MqttError::Connection(e.to_string())),
        }
    }
}

async fn poll_once(eventloop: &mut EventLoop) -> Result<(), MqttError> {
    eventloop
        .poll()
        .await
        .map(|_| ())
        .map_err(|e| MqttError::Connection(e.to_string()))
}

#[derive(Debug)]
enum MqttError {
    Connection(String),
    Publish(String),
    Timeout(Duration),
}

impl fmt::Display for MqttError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MqttError::Connection(s) => write!(f, "Connection error: {s}"),
            MqttError::Publish(s) => write!(f, "Publish error: {s}"),
            MqttError::Timeout(d) => write!(f, "Timed out after {d:?}"),
        }
    }
}

/// Publish a message to an MQTT broker.
pub async fn dispatch(
    action: &MqttAction,
    ctx: &TemplateContext,
    dispatch_ctx: &DispatchContext,
) -> Result<(), String> {
    if action.topic.is_empty() {
        return Err(format!(
            "MQTT action '{}': topic is empty",
            action.common.name
        ));
    }

    if action.host.is_empty() {
        return Err(format!(
            "MQTT action '{}': broker host is empty",
            action.common.name
        ));
    }

    let payload = ctx.render(&action.body_template);
    let topic = ctx.render(&action.topic);
    let timeout = Duration::from_secs(action.timeout_secs.max(1));

    let mqttoptions = build_mqtt_options(action);

    let qos = match action.qos {
        1 => QoS::AtLeastOnce,
        2 => QoS::ExactlyOnce,
        _ => QoS::AtMostOnce,
    };

    let conn_key = MqttConnectionKey::from_action(action);
    let action_name = action.common.name.clone();

    run_with_retry(
        &format!("MQTT '{}'", action.common.name),
        action.retry_count,
        || {
            let mqttoptions = mqttoptions.clone();
            let topic = topic.clone();
            let payload = payload.clone();
            let conn_key = conn_key.clone();
            let action_name = action_name.clone();
            let mqtt_registry = dispatch_ctx.mqtt_registry.clone();

            async move {
                let session = mqtt_registry
                    .get_or_create(conn_key.clone(), action_name.clone(), mqttoptions.clone())
                    .await;

                match session
                    .publish(&topic, qos, action.retain, &payload, timeout)
                    .await
                {
                    Ok(()) => Ok(()),
                    Err(e) => {
                        if let MqttError::Connection(_) = &e {
                            mqtt_registry.invalidate(&conn_key).await;
                        }
                        Err(e.to_string())
                    }
                }
            }
        },
    )
    .await?;

    debug!("✅ MQTT: Successfully published message to topic '{topic}'");
    Ok(())
}

fn build_mqtt_options(action: &MqttAction) -> MqttOptions {
    let mut mqttoptions = MqttOptions::new(&action.common.name, &action.host, action.port);
    mqttoptions.set_keep_alive(Duration::from_secs(5));

    if !action.username.is_empty() {
        mqttoptions.set_credentials(action.username.clone(), action.password.clone());
    }

    if action.use_tls {
        use rumqttc::tokio_rustls::rustls;
        let mut root_store = rustls::RootCertStore::empty();
        let cert_result = rustls_native_certs::load_native_certs();
        for cert in cert_result.certs {
            if let Err(e) = root_store.add(cert) {
                log::warn!("Failed to add a native cert to MQTT root store: {e}");
            }
        }

        let tls_config = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();

        mqttoptions.set_transport(Transport::tls_with_config(tls_config.into()));
    }

    mqttoptions
}
