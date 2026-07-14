use crate::core::alerts::{
    dispatch::run_with_retry, template::TemplateContext, types::TelegramAction,
};
use serde_json::json;

/// Send a Telegram message using official Bot API ("bot") or Bot-less CallMeBot API ("botless").
pub async fn dispatch(
    action: &TelegramAction,
    ctx: &TemplateContext,
    client: &reqwest::Client,
) -> Result<(), String> {
    if action.chat_id.is_empty() {
        return Err(format!(
            "Telegram action '{}': chat_id / username is empty",
            action.common.name
        ));
    }

    let is_botless = action.mode == "botless";

    if !is_botless && action.bot_token.is_empty() {
        return Err(format!(
            "Telegram action '{}': bot_token is empty",
            action.common.name
        ));
    }

    let body = ctx.render(&action.body_template);

    if is_botless {
        // Bot-less mode via CallMeBot API
        let user = if action.chat_id.starts_with('@') {
            action.chat_id.clone()
        } else {
            format!("@{}", action.chat_id)
        };

        run_with_retry(
            &format!("Telegram (Bot-less) '{}'", action.common.name),
            action.retry_count,
            || {
                let user = user.clone();
                let body = body.clone();

                async move {
                    let resp = client
                        .get("https://api.callmebot.com/text.php")
                        .query(&[("user", user.as_str()), ("text", body.as_str())])
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
    } else {
        // Official Bot API mode
        let api_url = format!("https://api.telegram.org/bot{}/", action.bot_token);

        run_with_retry(
            &format!("Telegram '{}'", action.common.name),
            action.retry_count,
            || {
                let api_url = api_url.clone();
                let body = body.clone();

                async move {
                    let resp = client
                        .post(format!("{api_url}sendMessage"))
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
}
