use crate::utils::io::file_stream::{FILE_CHUNK_SIZE, file_metadata, file_reader};
use async_trait::async_trait;
use serde_json::{Map, Value};

use crate::rclone::backend::transport::{BackendError, TransportKind};
use crate::rclone::backend::{RcloneTransport, rclone_ffi};

#[derive(Clone)]
pub struct RcloneLibBackend;

#[async_trait]
impl RcloneTransport for RcloneLibBackend {
    async fn kind(&self) -> TransportKind {
        TransportKind::Librclone
    }

    async fn rpc(&self, endpoint: &str, payload: Option<&Value>) -> Result<Value, BackendError> {
        let mut input = payload
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));

        if let Value::Object(ref mut map) = input {
            map.insert("_path".into(), Value::String(endpoint.to_string()));
        } else {
            let mut wrapper = Map::new();
            wrapper.insert("_path".into(), Value::String(endpoint.to_string()));
            wrapper.insert("input".into(), input);
            input = Value::Object(wrapper);
        }

        crate::utils::spawn_blocking(move || rclone_ffi::rpc(&input))
            .await
            .map_err(|e| BackendError::Other(format!("librclone FFI join error: {e}")))?
    }

    async fn read_file(
        &self,
        remote: &str,
        path: &str,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<Box<dyn tokio::io::AsyncRead + Unpin + Send>, BackendError> {
        // This transport always addresses the in-process local engine. Routing
        // decisions belong to RoutingTransport, including during backend switches.
        let (offset, count) = read_bounds(range)?;
        let offset = offset.unwrap_or(0);
        if count.is_none_or(|count| count > FILE_CHUNK_SIZE as i64) {
            let transport: std::sync::Arc<dyn RcloneTransport> = std::sync::Arc::new(self.clone());
            let version = file_metadata(transport.as_ref(), remote, path).await?;
            let length = version
                .size
                .saturating_sub(offset as u64)
                .min(count.map_or(u64::MAX, |count| count as u64));
            return Ok(Box::new(file_reader(
                transport,
                remote.to_owned(),
                path.to_owned(),
                offset as u64,
                length,
                Some(version),
            )));
        }
        let count =
            count.ok_or_else(|| BackendError::Stream("Missing bounded file range".into()))?;
        let (remote, path) = crate::utils::io::file_stream::file_location(remote, path);
        let full_path = crate::utils::json_helpers::build_full_path(remote, path);
        let token = uuid::Uuid::new_v4().to_string();
        let mut cancel = CancelFileRead {
            transport: self.clone(),
            token: token.clone(),
            armed: true,
        };
        let response = self
            .rpc(
                "operations/readfile",
                Some(&serde_json::json!({
                    "fs": full_path, "offset": offset, "count": count,
                    "base64": true, "readToken": token,
                })),
            )
            .await;
        cancel.armed = false;
        let response = response?;
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                response["result"]
                    .as_str()
                    .ok_or_else(|| BackendError::Stream("Missing file bytes".into()))?,
            )
            .map_err(|e| BackendError::Stream(e.to_string()))?;
        if bytes.len() as i64 > count {
            return Err(BackendError::Stream(
                "Read exceeded requested file range".into(),
            ));
        }
        Ok(Box::new(std::io::Cursor::new(bytes)))
    }
}

struct CancelFileRead {
    transport: RcloneLibBackend,
    token: String,
    armed: bool,
}

impl Drop for CancelFileRead {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let transport = self.transport.clone();
        let token = self.token.clone();
        crate::utils::spawn(async move {
            if let Err(error) = transport
                .rpc(
                    "operations/cancelread",
                    Some(&serde_json::json!({"readToken": token})),
                )
                .await
            {
                log::warn!("Failed to cancel media read: {error}");
            }
        });
    }
}

fn read_bounds(
    range: Option<(u64, Option<u64>)>,
) -> Result<(Option<i64>, Option<i64>), BackendError> {
    let Some((start, end)) = range else {
        return Ok((None, None));
    };
    let invalid = || BackendError::Other("Invalid file range".into());
    let offset = i64::try_from(start).map_err(|_| invalid())?;
    let count = end
        .map(|end| {
            end.checked_sub(start)
                .and_then(|value| value.checked_add(1))
                .and_then(|value| i64::try_from(value).ok())
                .ok_or_else(invalid)
        })
        .transpose()?;
    Ok((Some(offset), count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_bounds_rejects_wrapping_or_negative_ranges() {
        assert_eq!(read_bounds(None).unwrap(), (None, None));
        assert_eq!(read_bounds(Some((10, None))).unwrap(), (Some(10), None));
        assert_eq!(
            read_bounds(Some((10, Some(19)))).unwrap(),
            (Some(10), Some(10))
        );
        for range in [
            (10, Some(9)),
            (u64::MAX, None),
            (0, Some(u64::MAX)),
            (0, Some(i64::MAX as u64)),
        ] {
            assert!(read_bounds(Some(range)).is_err());
        }
    }
}
