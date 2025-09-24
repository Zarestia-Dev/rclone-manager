use log::debug;
use reqwest;

pub async fn download_rclone_zip(
    os_name: &str,
    arch: &str,
    version: &str,
) -> Result<Vec<u8>, String> {
    let download_url =
        format!("https://downloads.rclone.org/{version}/rclone-{version}-{os_name}-{arch}.zip");

    debug!("Download URL: {download_url}");

    let mut retries = 3;
    while retries > 0 {
        match reqwest::get(&download_url).await {
            Ok(resp) => {
                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| format!("Read failed: {e}"))?;
                return Ok(bytes.to_vec());
            }
            Err(e) => {
                retries -= 1;
                if retries == 0 {
                    return Err(format!("Download failed after 3 tries: {e}"));
                }
            }
        }
    }

    Err("Unknown error downloading Rclone".into())
}
