use crate::core::alerts::{
    dispatch::run_with_retry, template::TemplateContext, types::EmailAction,
};
use lettre::{
    AsyncTransport, Message, message::header::ContentType,
    transport::smtp::authentication::Credentials,
};
use log::debug;

/// Send an email notification.
pub async fn dispatch(action: &EmailAction, ctx: &TemplateContext) -> Result<(), String> {
    if action.smtp_server.is_empty() {
        return Err(format!(
            "Email action '{}': smtp_server is empty",
            action.common.name
        ));
    }

    if action.to.is_empty() {
        return Err(format!(
            "Email action '{}': to address is empty",
            action.common.name
        ));
    }

    let subject = ctx.render(&action.subject_template);
    let body = ctx.render(&action.body_template);

    debug!(
        "📧 Sending Email: '{}' via {} to {}",
        action.common.name, action.smtp_server, action.to
    );

    let from = if action.from.is_empty() {
        "rclone-manager@localhost"
    } else {
        &action.from
    };

    let email = Message::builder()
        .from(
            from.parse()
                .map_err(|e| format!("Invalid from address: {e}"))?,
        )
        .to(action
            .to
            .parse()
            .map_err(|e| format!("Invalid to address: {e}"))?)
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .body(body)
        .map_err(|e| format!("Failed to build email: {e}"))?;

    let mut mailer_builder = if action.encryption == "tls" {
        let port = if action.smtp_port == 0 {
            465
        } else {
            action.smtp_port
        };
        lettre::AsyncSmtpTransport::<lettre::Tokio1Executor>::relay(&action.smtp_server)
            .map_err(|e| format!("SMTP relay error: {e}"))?
            .port(port)
            .tls(lettre::transport::smtp::client::Tls::Required(
                lettre::transport::smtp::client::TlsParameters::new(action.smtp_server.clone())
                    .map_err(|e| format!("TLS parameters error: {e}"))?,
            ))
    } else if action.encryption == "starttls" {
        let port = if action.smtp_port == 0 {
            587
        } else {
            action.smtp_port
        };
        lettre::AsyncSmtpTransport::<lettre::Tokio1Executor>::relay(&action.smtp_server)
            .map_err(|e| format!("SMTP relay error: {e}"))?
            .port(port)
            .tls(lettre::transport::smtp::client::Tls::Opportunistic(
                lettre::transport::smtp::client::TlsParameters::new(action.smtp_server.clone())
                    .map_err(|e| format!("TLS parameters error: {e}"))?,
            ))
    } else {
        let port = if action.smtp_port == 0 {
            25
        } else {
            action.smtp_port
        };
        lettre::AsyncSmtpTransport::<lettre::Tokio1Executor>::relay(&action.smtp_server)
            .map_err(|e| format!("SMTP relay error: {e}"))?
            .port(port)
            .tls(lettre::transport::smtp::client::Tls::None)
    };

    if !action.username.is_empty() {
        mailer_builder = mailer_builder.credentials(Credentials::new(
            action.username.clone(),
            action.password.clone(),
        ));
    }

    let mailer = mailer_builder.build();

    run_with_retry(
        &format!("Email '{}'", action.common.name),
        action.retry_count,
        || {
            let mailer = mailer.clone();
            let email = email.clone();
            async move {
                mailer
                    .send(email)
                    .await
                    .map(|_| ())
                    .map_err(|e| format!("Failed to send email: {e}"))
            }
        },
    )
    .await
}
