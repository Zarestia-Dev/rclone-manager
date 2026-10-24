use std::collections::HashMap;

use crate::context::AppHandle;
use serde_json::Value;

use crate::rclone::backend::{routing_transport::RoutingTransport, types::Backend};
use crate::rclone::endpoints::config;

pub async fn get_all_remote_configs_for_backend(
    app: AppHandle,
    backend: &Backend,
) -> Result<Value, String> {
    let json = RoutingTransport::for_backend(app, backend.clone())
        .rpc(config::DUMP, None)
        .await
        .map_err(|e| format!("❌ Failed to fetch remote configs: {e}"))?;

    Ok(json)
}

/// Fetch all remote types
pub async fn get_remote_types(app: AppHandle) -> Result<HashMap<String, Vec<Value>>, String> {
    let json = crate::rclone::commands::common::transport(&app)
        .rpc(config::PROVIDERS, None)
        .await
        .map_err(|e| format!("❌ Failed to send request: {e}"))?;

    let providers: HashMap<String, Vec<Value>> =
        serde_json::from_value(json).map_err(|e| format!("❌ Failed to parse response: {e}"))?;

    Ok(providers)
}
