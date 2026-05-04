use crate::core::alerts::{dispatch::run_with_retry, template::TemplateContext, types::MqttAction};
use log::debug;
use rumqttc::Transport;
use rumqttc::v5::mqttbytes::QoS;
use rumqttc::v5::{AsyncClient, Event, MqttOptions, mqttbytes::v5::Packet};
use std::time::Duration;

/// Publish a message to an MQTT broker.
pub async fn dispatch(action: &MqttAction, ctx: &TemplateContext) -> Result<(), String> {
    if action.common.id.is_empty() {
        return Err(format!(
            "MQTT action '{}': broker host is empty",
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

    debug!(
        "📡 Publishing to MQTT: '{}' at {}:{} (tls: {}) → topic: {}",
        action.common.name, action.host, action.port, action.use_tls, topic
    );

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
                log::warn!("Failed to add a native cert to MQTT root store: {}", e);
            }
        }

        let tls_config = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();

        mqttoptions.set_transport(Transport::tls_with_config(tls_config.into()));
    }

    let qos = match action.qos {
        1 => QoS::AtLeastOnce,
        2 => QoS::ExactlyOnce,
        _ => QoS::AtMostOnce,
    };

    run_with_retry(
        &format!("MQTT '{}'", action.common.name),
        action.retry_count,
        || {
            let mqttoptions = mqttoptions.clone();
            let topic = topic.clone();
            let payload = payload.clone();

            async move {
                publish_and_close(mqttoptions, topic, qos, action.retain, payload, timeout).await
            }
        },
    )
    .await?;

    debug!(
        "✅ MQTT: Successfully published message to topic '{}'",
        topic
    );
    Ok(())
}

async fn publish_and_close(
    opts: MqttOptions,
    topic: String,
    qos: QoS,
    retain: bool,
    payload: String,
    timeout: Duration,
) -> Result<(), String> {
    let (client, mut eventloop) = AsyncClient::new(opts, 10);

    let publish_fut = async {
        loop {
            let notification = eventloop
                .poll()
                .await
                .map_err(|e| format!("Connection error: {e}"))?;

            match notification {
                Event::Incoming(Packet::ConnAck(_)) => {
                    client
                        .publish(topic.clone(), qos, retain, payload.clone())
                        .await
                        .map_err(|e| format!("Publish error: {e}"))?;

                    if qos == QoS::AtMostOnce {
                        // QoS 0: fire-and-forget, no ack expected.
                        return Ok(());
                    }
                }
                Event::Incoming(Packet::PubAck(_))
                | Event::Incoming(Packet::PubRec(_))
                | Event::Incoming(Packet::PubComp(_)) => {
                    return Ok(());
                }
                _ => {}
            }
        }
    };

    tokio::time::timeout(timeout, publish_fut)
        .await
        .map_err(|_| format!("Timed out after {timeout:?}"))?
}
