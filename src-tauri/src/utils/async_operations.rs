use log::{debug, error, warn};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::sleep;

use crate::{
    rclone::state::engine::ENGINE_STATE,
    utils::rclone::endpoints::{EndpointHelper, job},
};

/// Monitor an async operation until completion and return the result
/// Simple and direct: returns data on success, error message on failure
async fn monitor_async_operation(
    jobid: u64,
    operation_name: &str,
    client: reqwest::Client,
) -> Result<Value, String> {
    debug!("Monitoring async operation {operation_name} with jobid {jobid}");

    let job_status_url = EndpointHelper::build_url(&ENGINE_STATE.get_api().0, job::STATUS);

    let mut consecutive_errors = 0;
    const MAX_CONSECUTIVE_ERRORS: u8 = 3;

    loop {
        // Query job status
        match client
            .post(&job_status_url)
            .json(&json!({ "jobid": jobid }))
            .send()
            .await
        {
            Ok(response) => {
                consecutive_errors = 0;

                match response.text().await {
                    Ok(body) => {
                        match serde_json::from_str::<Value>(&body) {
                            Ok(job_status) => {
                                let finished = job_status
                                    .get("finished")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);

                                if finished {
                                    let success = job_status
                                        .get("success")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false);

                                    if success {
                                        // Return the output data
                                        let data = job_status
                                            .get("output")
                                            .cloned()
                                            .unwrap_or_else(|| json!({}));

                                        debug!(
                                            "Async operation {operation_name} completed successfully"
                                        );
                                        return Ok(data);
                                    } else {
                                        // Return the error message
                                        let error = job_status
                                            .get("error")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("Operation failed")
                                            .to_string();

                                        debug!("Async operation {operation_name} failed: {error}");
                                        return Err(error);
                                    }
                                }
                            }
                            Err(e) => {
                                warn!("Failed to parse job status for {operation_name}: {e}");
                            }
                        }
                    }
                    Err(e) => {
                        warn!("Failed to get response body for {operation_name}: {e}");
                    }
                }
            }
            Err(e) => {
                consecutive_errors += 1;
                warn!(
                    "Error checking async operation {operation_name} (attempt {consecutive_errors}/{MAX_CONSECUTIVE_ERRORS}): {e}"
                );

                if consecutive_errors >= MAX_CONSECUTIVE_ERRORS {
                    error!("Too many errors monitoring {operation_name}, giving up");
                    return Err(format!(
                        "Too many consecutive errors monitoring operation: {e}"
                    ));
                }
            }
        }

        sleep(Duration::from_millis(500)).await;
    }
}

/// Execute an async operation and wait for result
/// Simple wrapper: execute operation, get jobid, monitor until done, return result
pub async fn execute_async_operation<F, Fut>(
    operation_name: &str,
    client: reqwest::Client,
    operation_fn: F,
) -> Result<Value, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<u64, String>>,
{
    // Execute the operation to get jobid
    let jobid = operation_fn().await?;

    // Monitor until completion and return result directly
    monitor_async_operation(jobid, operation_name, client).await
}
