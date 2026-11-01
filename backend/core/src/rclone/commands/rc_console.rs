//! Developer console: raw rclone RC calls that keep the HTTP status and timing.

use std::time::Instant;

use serde::Serialize;
use serde_json::{Value, json};

use crate::context::AppHandle;
use crate::rclone::backend::transport::BackendError;
use crate::utils::types::state::RcloneState;

/// What an RC call returned. A call rclone refused is a response too, not an `Err`, so the console
/// can show rclone's own status and message.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RcConsoleResponse {
    pub ok: bool,
    /// HTTP status of a refused call; `None` for a success.
    pub status: Option<u16>,
    pub duration_ms: u64,
    pub body: Value,
}

/// Rclone's answer is a response. A call that never reached rclone is an error, as its text comes
/// from this app and has to be translated.
fn into_response(
    result: Result<Value, BackendError>,
    duration_ms: u64,
) -> Result<RcConsoleResponse, String> {
    match result {
        Ok(body) => Ok(RcConsoleResponse {
            ok: true,
            status: None,
            duration_ms,
            body,
        }),
        Err(BackendError::Rpc {
            status, message, ..
        }) => Ok(RcConsoleResponse {
            ok: false,
            status: Some(status),
            duration_ms,
            body: json!({ "error": message }),
        }),
        Err(e) => Err(crate::localized_error!(
            "backendErrors.rcConsole.transportFailed",
            "error" => e
        )),
    }
}

/// Runs any RC command against the active backend. The name is passed on as typed: rclone answers
/// an unknown one with its own error.
pub async fn rc_console_call(
    app: AppHandle,
    command: String,
    params: Option<Value>,
) -> Result<RcConsoleResponse, String> {
    let command = command.trim().trim_matches('/');
    if command.is_empty() {
        return Err(crate::localized_error!(
            "backendErrors.rcConsole.emptyCommand"
        ));
    }

    let params = params.unwrap_or_else(|| json!({}));
    let transport = app.state::<RcloneState>().transport.clone();
    let started = Instant::now();
    let result = transport.rpc(command, Some(&params)).await;
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    into_response(result, duration_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn success_keeps_body_and_has_no_status() {
        let res = into_response(Ok(json!({ "version": "v1.70.0" })), 12).unwrap();
        assert!(res.ok);
        assert_eq!(res.status, None);
        assert_eq!(res.duration_ms, 12);
        assert_eq!(res.body["version"], "v1.70.0");
    }

    #[test]
    fn rpc_failure_keeps_status_and_rclone_message() {
        let res = into_response(
            Err(BackendError::Rpc {
                endpoint: "operations/list".into(),
                status: 400,
                message: "couldn't find fs".into(),
            }),
            3,
        )
        .unwrap();
        assert!(!res.ok);
        assert_eq!(res.status, Some(400));
        assert_eq!(res.body["error"], "couldn't find fs");
    }

    #[test]
    fn transport_failure_is_a_localized_error() {
        let err = into_response(Err(BackendError::NotConnected("down".into())), 0).unwrap_err();
        let parsed: Value = serde_json::from_str(&err).unwrap();
        assert_eq!(parsed["key"], "backendErrors.rcConsole.transportFailed");
        assert_eq!(parsed["params"]["error"], "transport not connected: down");
    }

    #[test]
    fn response_serializes_camel_case() {
        let value = serde_json::to_value(into_response(Ok(json!({})), 5).unwrap()).unwrap();
        assert_eq!(value["durationMs"], 5);
    }
}
