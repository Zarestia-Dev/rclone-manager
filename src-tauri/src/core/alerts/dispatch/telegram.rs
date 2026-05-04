use crate::core::alerts::{
    dispatch::run_with_retry, template::TemplateContext, types::TelegramAction,
};
use log::debug;
use serde_json::json;

/// Send a Telegram message to a chat using the Bot API.
pub async fn dispatch(
    action: &TelegramAction,
    ctx: &TemplateContext,
    client: &reqwest::Client,
) -> Result<(), String> {
    if action.bot_token.is_empty() {
        return Err(format!(
            "Telegram action '{}': bot_token is empty",
            action.common.name
        ));
    }

    if action.chat_id.is_empty() {
        return Err(format!(
            "Telegram action '{}': chat_id is empty",
            action.common.name
        ));
    }

    let body = ctx.render(&action.body_template);
    let api_url = format!("https://api.telegram.org/bot{}/", action.bot_token);

    run_with_retry(
        &format!("Telegram '{}'", action.common.name),
        action.retry_count,
        || {
            let api_url = api_url.clone();
            let body = body.clone();

            async move {
                debug!("📱 Sending Telegram message to chat {}", action.chat_id);
                let resp = client
                    .post(format!("{}sendMessage", api_url))
                    .json(&json!({
                        "chat_id": action.chat_id,
                        "text": body,
                    }))
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;

                let status = resp.status();
                if status.is_success() {
                    return Ok(());
                }

                Err(format!(
                    "HTTP {}: {}",
                    status.as_u16(),
                    resp.text().await.unwrap_or_default()
                ))
            }
        },
    )
    .await
}
