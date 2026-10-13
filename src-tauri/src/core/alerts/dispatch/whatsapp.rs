use crate::core::alerts::{
    dispatch::run_with_retry, template::TemplateContext, types::WhatsappAction,
};

/// Send a WhatsApp message using CallMeBot API or a custom gateway.
pub async fn dispatch(
    action: &WhatsappAction,
    ctx: &TemplateContext,
    client: &reqwest::Client,
) -> Result<(), String> {
    if action.phone.is_empty() {
        return Err(format!(
            "WhatsApp action '{}': phone is empty",
            action.common.name
        ));
    }

    if action.provider == "callmebot" && action.apikey.is_empty() {
        return Err(format!(
            "WhatsApp action '{}': apikey is empty for CallMeBot",
            action.common.name
        ));
    }

    let body = ctx.render(&action.body_template);

    if action.provider == "custom_gateway" {
        let url = action.gateway_url.as_deref().unwrap_or("").trim();

        if url.is_empty() {
            return Err(format!(
                "WhatsApp action '{}': custom gateway_url is empty",
                action.common.name
            ));
        }

        let url = url.to_string();

        run_with_retry(
            &format!("WhatsApp Gateway '{}'", action.common.name),
            action.retry_count,
            || {
                let url = url.clone();
                let body = body.clone();
                let phone = action.phone.clone();
                let apikey = action.apikey.clone();

                async move {
                    let resp = client
                        .get(&url)
                        .query(&[
                            ("phone", phone.as_str()),
                            ("text", body.as_str()),
                            ("apikey", apikey.as_str()),
                        ])
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
        // CallMeBot standard endpoint: https://api.callmebot.com/whatsapp.php?phone=[phone]&text=[text]&apikey=[apikey]
        run_with_retry(
            &format!("WhatsApp (CallMeBot) '{}'", action.common.name),
            action.retry_count,
            || {
                let phone = action.phone.clone();
                let body = body.clone();
                let apikey = action.apikey.clone();

                async move {
                    let resp = client
                        .get("https://api.callmebot.com/whatsapp.php")
                        .query(&[
                            ("phone", phone.as_str()),
                            ("text", body.as_str()),
                            ("apikey", apikey.as_str()),
                        ])
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
