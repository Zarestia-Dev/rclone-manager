use log::debug;
use reqwest;

pub async fn download_rclone_zip(os_name: &str, arch: &str) -> Result<(String, Vec<u8>), String> {
    let version_txt = reqwest::get("https://downloads.rclone.org/version.txt")
        .await
        .map_err(|e| format!("Failed to fetch version: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Failed to read version text: {}", e))?;

    let version = version_txt.trim().replace("rclone v", "");
    let download_url = format!(
        "https://downloads.rclone.org/v{}/rclone-v{}-{}-{}.zip",
        version, version, os_name, arch
    );

    debug!("Download URL: {}", download_url);

    let mut retries = 3;
    while retries > 0 {
        match reqwest::get(&download_url).await {
            Ok(resp) => {
                let bytes = resp
                    .bytes()
                    .await
                    .map_err(|e| format!("Read failed: {}", e))?;
                return Ok((version, bytes.to_vec()));
            }
            Err(e) => {
                retries -= 1;
                if retries == 0 {
                    return Err(format!("Download failed after 3 tries: {}", e));
                }
            }
        }
    }

    Err("Unknown error downloading Rclone".into())
}
