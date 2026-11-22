use std::collections::{HashMap, HashSet};
#[cfg(target_os = "linux")]
use std::process::Command;

use crate::context::AppHandle;
use log::debug;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sysinfo::Disks;

use crate::rclone::backend::{
    BackendError, BackendManager, RcloneTransport, routing_transport::RoutingTransport,
    types::Backend,
};
use crate::rclone::commands::common::{backend_os, is_directory, parse_fs, split_file_path};
use crate::rclone::endpoints::core;
use crate::rclone::endpoints::operations;
use crate::utils::json_helpers::normalize_windows_path;
use crate::utils::types::jobs::JobType;
use crate::utils::types::rclone::DiskUsage;
use crate::utils::types::remotes::ListOptions;
use crate::{
    rclone::commands::job::{JobMetadata, SubmitJobOptions, submit_job_with_options},
    utils::json_helpers::build_full_path,
};

async fn run_fs_command_as_job(
    app: AppHandle,
    endpoint: &str,
    mut payload: serde_json::Value,
    metadata: JobMetadata,
    backend: Option<Backend>,
) -> Result<serde_json::Value, String> {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("_async".to_string(), json!(true));
    }
    let submission = submit_job_with_options(
        app,
        endpoint,
        payload,
        metadata,
        SubmitJobOptions {
            wait_for_completion: true,
            backend,
        },
    )
    .await?;
    Ok(submission.output.unwrap_or_else(|| json!({})))
}

/// Runs a metadata query as one direct rc call. These answer in a single round trip, so running
/// them as async jobs only added the job bookkeeping and a poll interval of 500 ms. The group
/// stays on the call: rclone registers every call as a job, so `job/stopgroup` still cancels it.
async fn run_fs_query(
    app: &AppHandle,
    endpoint: &str,
    mut payload: serde_json::Value,
    group: Option<String>,
    backend: Option<Backend>,
) -> Result<serde_json::Value, String> {
    if let (Some(group), Some(params)) = (group, payload.as_object_mut()) {
        params.insert("_group".to_string(), json!(group));
    }
    let backend = match backend {
        Some(backend) => backend,
        None => app.state::<BackendManager>().get_active().await,
    };
    RoutingTransport::for_backend(app.clone(), backend)
        .rpc(endpoint, Some(&payload))
        .await
        .map_err(|error| match error {
            // The error rclone reports, as a failed job would have carried it.
            BackendError::Rpc { message, .. } => {
                crate::rclone::engine::error_mapper::map_or_wrap_job_error(&message)
            }
            other => crate::localized_error!("backendErrors.request.failed", "error" => other),
        })
}

fn create_fs_params(
    remote: &str,
    path: Option<&str>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(remote));
    params.insert("remote".to_string(), json!(path));
    params
}

#[derive(Serialize, Clone)]
pub struct LocalDrive {
    id: String,
    name: String,
    label: String,
    total_space: u64,
    file_system: String,
}

#[derive(Debug, Deserialize)]
pub struct PublicLinkParams {
    pub unlink: Option<bool>,
    pub expire: Option<String>,
}

/// `_origin` stays in the signature for the command contract; queries are not listed as jobs.
pub async fn get_fs_info(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    _origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("ℹ️ Getting fs info for remote: {remote}, path: {path:?}");

    let params = create_fs_params(&remote, path.as_deref());
    let mut data = run_fs_query(&app, operations::FSINFO, json!(params), group, None).await?;

    if let Some(root) = data.get_mut("Root")
        && let Some(root_str) = root.as_str()
    {
        *root = json!(normalize_windows_path(root_str));
    }

    Ok(data)
}

pub async fn get_remote_paths(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    options: Option<ListOptions>,
    _origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("📂 Listing remote paths for remote: {remote}, path: {path:?}");
    let mut params = create_fs_params(&remote, path.as_deref());

    if let Some(list_options) = options {
        let opt: serde_json::Map<String, serde_json::Value> =
            list_options.extra.into_iter().collect();
        params.insert("opt".to_string(), json!(opt));
    }

    run_fs_query(&app, operations::LIST, json!(params), group, None).await
}

fn detect_home_dir() -> Option<String> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .ok()
            .map(|h| h.replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok()
    }
}

fn normalize_drive_path(path: &str, os: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if os == "windows" {
        if trimmed.len() == 2
            && trimmed.ends_with(':')
            && trimmed.as_bytes()[0].is_ascii_alphabetic()
        {
            return format!("{trimmed}\\");
        }
        return trimmed.replace('/', "\\");
    }

    if os != "android" {
        return trimmed.to_string();
    }
    if trimmed == "/sdcard" {
        return "/storage/emulated/0".to_string();
    }
    if let Some(suffix) = trimmed.strip_prefix("/sdcard/") {
        return format!("/storage/emulated/0/{suffix}");
    }

    if !trimmed.starts_with('/') {
        let folder = if trimmed.eq_ignore_ascii_case("downloads") {
            "Download"
        } else {
            trimmed
        };
        return format!("/storage/emulated/0/{folder}");
    }

    trimmed.to_string()
}

fn is_home_directory(normalized_path: &str, home: Option<&str>, os: &str) -> bool {
    let clean_path = normalized_path.trim_end_matches(['/', '\\']);
    if let Some(h) = home {
        let clean_home = h.trim_end_matches(['/', '\\']);
        if clean_path == clean_home
            || (os == "windows" && clean_path.eq_ignore_ascii_case(clean_home))
        {
            return true;
        }
    }
    match os {
        "windows" => {
            let parts: Vec<_> = clean_path
                .split(['/', '\\'])
                .filter(|s| !s.is_empty())
                .collect();
            parts.len() == 3
                && parts[0].len() == 2
                && parts[0].as_bytes()[0].is_ascii_alphabetic()
                && parts[0].ends_with(':')
                && parts[1].eq_ignore_ascii_case("Users")
        }
        "darwin" | "macos" => {
            clean_path.starts_with("/Users/")
                && clean_path.split('/').filter(|s| !s.is_empty()).count() == 2
        }
        "linux" => {
            clean_path.starts_with("/home/")
                && clean_path.split('/').filter(|s| !s.is_empty()).count() == 2
        }
        _ => false,
    }
}

#[cfg(target_os = "linux")]
async fn fetch_linux_drive_labels() -> HashMap<String, String> {
    crate::utils::spawn_blocking(|| {
        let mut map = HashMap::new();
        if let Ok(output) = Command::new("lsblk").args(["-no", "KNAME,LABEL"]).output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let mut parts = line.splitn(2, |c: char| c.is_whitespace());
                if let (Some(kname), Some(label)) = (parts.next(), parts.next()) {
                    let label = label.trim();
                    if !label.is_empty() {
                        map.insert(format!("/dev/{kname}"), label.to_string());
                    }
                }
            }
        }
        map
    })
    .await
    .unwrap_or_default()
}

pub async fn get_local_drives(app: AppHandle) -> Result<Vec<LocalDrive>, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    let os = backend_os(&app, &backend).await?;
    let is_local_backend = backend.is_local;
    let transport = RoutingTransport::for_backend(app, backend);
    Ok(load_local_drives(transport.as_ref(), &os, is_local_backend).await)
}

async fn load_local_drives(
    transport: &dyn RcloneTransport,
    os: &str,
    is_local_backend: bool,
) -> Vec<LocalDrive> {
    // 1. Fetch rclone core/disks with a 3-second timeout
    let rclone_disks_future = async {
        transport
            .rpc(core::DISKS, None)
            .await
            .ok()
            .and_then(|resp| {
                resp.get("disks").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|val| {
                            val.as_str()
                                .filter(|path| !path.trim().is_empty())
                                .map(str::to_string)
                        })
                        .collect::<Vec<String>>()
                })
            })
    };

    // 2. Refresh sysinfo disks in a blocking task with a 3-second timeout
    let sys_disks_future = async {
        if !is_local_backend {
            return Disks::default();
        }
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            crate::utils::spawn_blocking(Disks::new_with_refreshed_list),
        )
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default()
    };

    let (rclone_disks_opt, sys_disks) = tokio::join!(
        tokio::time::timeout(std::time::Duration::from_secs(3), rclone_disks_future),
        sys_disks_future,
    );

    let disks_paths: Vec<String> = match rclone_disks_opt {
        Ok(Some(paths)) if !paths.is_empty() => paths,
        _ => {
            let sys_paths: Vec<String> = sys_disks
                .iter()
                .map(|d| d.mount_point().to_string_lossy().into_owned())
                .filter(|p| !p.is_empty())
                .collect();
            if !sys_paths.is_empty() {
                sys_paths
            } else {
                vec![
                    match os {
                        "windows" => "C:\\",
                        "android" => "/storage/emulated/0",
                        _ => "/",
                    }
                    .to_string(),
                ]
            }
        }
    };

    let mut disks_paths = disks_paths;
    if os == "android" {
        let emulated_root = "/storage/emulated/0".to_string();
        if !disks_paths
            .iter()
            .any(|p| p == &emulated_root || p == "/sdcard")
        {
            disks_paths.insert(0, emulated_root);
        }
    }

    let home = is_local_backend.then(detect_home_dir).flatten();

    // Pre-build a lookup table keyed by normalized mount point so we don't
    // do an O(N×M) linear scan with `format!` allocations per disk path.
    let sys_disk_by_mount: HashMap<String, usize> = {
        let mut map = HashMap::with_capacity(sys_disks.len());
        for (idx, d) in sys_disks.iter().enumerate() {
            let mp = d.mount_point().to_string_lossy().into_owned();
            map.insert(mp.clone(), idx);
            // Also index with a trailing slash variant for fuzzy matching.
            if !mp.ends_with('/') {
                map.insert(format!("{mp}/"), idx);
            }
        }
        map
    };

    #[cfg(target_os = "linux")]
    let labels = if is_local_backend {
        fetch_linux_drive_labels().await
    } else {
        HashMap::new()
    };

    let mut seen_paths = HashSet::new();
    disks_paths
        .into_iter()
        .filter_map(|path| {
            let normalized_path = normalize_drive_path(&path, os);

            if normalized_path.is_empty() || !seen_paths.insert(normalized_path.clone()) {
                return None;
            }

            // O(1) lookup with fuzzy trailing-slash matching.
            let sys_disk_idx = sys_disk_by_mount
                .get(&normalized_path)
                .or_else(|| {
                    if !normalized_path.ends_with('/') {
                        sys_disk_by_mount.get(&format!("{normalized_path}/"))
                    } else {
                        None
                    }
                })
                .copied();
            let sys_disk = sys_disk_idx.map(|i| &sys_disks[i]);

            let folder_name = normalized_path
                .split(['/', '\\'])
                .rfind(|s| !s.is_empty())
                .unwrap_or("")
                .to_string();

            let is_home = is_home_directory(&normalized_path, home.as_deref(), os);

            let label = if normalized_path == "/storage/emulated/0" {
                "nautilus.titles.internalStorage".to_string()
            } else if is_home {
                "titlebar.home".to_string()
            } else if normalized_path == "/" || normalized_path == "C:\\" {
                "nautilus.titles.fileSystem".to_string()
            } else {
                let mut drive_label = None;
                if let Some(d) = sys_disk {
                    let name = d.name().to_string_lossy();
                    #[cfg(target_os = "linux")]
                    {
                        if let Some(l) = labels.get(name.as_ref()) {
                            drive_label = Some(l.clone());
                        }
                    }
                    #[cfg(not(target_os = "linux"))]
                    {
                        if !name.is_empty() && !name.starts_with("\\\\") {
                            drive_label = Some(name.into_owned());
                        }
                    }
                }

                if let Some(l) = drive_label {
                    l
                } else if normalized_path.starts_with(home.as_deref().unwrap_or(""))
                    && !folder_name.is_empty()
                {
                    folder_name
                } else if let Some(d) = sys_disk {
                    d.name().to_string_lossy().into_owned()
                } else if !folder_name.is_empty() {
                    folder_name
                } else {
                    "nautilus.titles.localDisk".to_string()
                }
            };

            let id = sys_disk
                .map(|d| d.name().to_string_lossy().into_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| normalized_path.clone());

            Some(LocalDrive {
                id,
                name: normalized_path,
                label,
                total_space: sys_disk.map_or(0, sysinfo::Disk::total_space),
                file_system: sys_disk
                    .map(|d| d.file_system().to_string_lossy().into_owned())
                    .unwrap_or_default(),
            })
        })
        .collect()
}

pub async fn get_disk_usage(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    _origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<DiskUsage, String> {
    let backend = app.state::<BackendManager>().get_active().await;
    let windows = if crate::rclone::state::cache::is_local_path(&remote) {
        backend_os(&app, &backend).await? == "windows"
    } else {
        false
    };
    let transport = RoutingTransport::for_backend(app.clone(), backend.clone());
    let target_remote =
        disk_usage_root(transport.as_ref(), &remote, path.as_deref(), windows).await?;
    let fs_path = build_full_path(&remote, path.as_deref().unwrap_or(""));
    let params = create_fs_params(&target_remote, None);
    let json = run_fs_query(&app, operations::ABOUT, json!(params), group, Some(backend)).await?;

    let total = json["total"].as_i64().unwrap_or(0);
    let used = json["used"].as_i64().unwrap_or(0);
    let free = json["free"].as_i64().unwrap_or(0);

    debug!(
        "💾 Disk Usage for {fs_path} (resolved to {target_remote}): total={total} used={used} free={free}"
    );

    Ok(DiskUsage { free, used, total })
}

// A local filesystem belongs to the selected daemon, which may run on another OS.
async fn disk_usage_root(
    transport: &dyn RcloneTransport,
    remote: &str,
    path: Option<&str>,
    windows: bool,
) -> Result<String, String> {
    let (root, _) = parse_fs(remote, windows)
        .ok_or_else(|| crate::localized_error!("backendErrors.file.invalidPath"))?;
    let is_drive = windows && root.len() == 2 && root.as_bytes()[0].is_ascii_alphabetic();
    if root.ends_with(':') && !is_drive {
        return Ok(root);
    }
    let full_path = match path {
        Some(p) if !p.is_empty() => build_full_path(&root, p),
        _ => root,
    };
    let (parent, name) = split_file_path(&full_path, windows)
        .ok_or_else(|| crate::localized_error!("backendErrors.file.invalidPath"))?;
    if name.is_empty() || is_directory(transport, &full_path, None, windows).await? {
        Ok(full_path)
    } else {
        Ok(parent)
    }
}

pub async fn get_size(
    app: AppHandle,
    remote: String,
    path: Option<String>,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("📏 Getting size for remote: {remote}, path: {path:?}");

    let fs_with_path = build_full_path(&remote, path.as_deref().unwrap_or(""));
    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(fs_with_path));

    run_fs_command_as_job(
        app,
        operations::SIZE,
        json!(params),
        JobMetadata::for_query(remote, fs_with_path, JobType::Size, origin, group),
        None,
    )
    .await
}

pub async fn get_stat(
    app: AppHandle,
    remote: String,
    path: String,
    opt: Option<serde_json::Value>,
    _origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("📊 Getting stats for remote: {remote}, path: {path}");

    let mut params = create_fs_params(&remote, Some(&path));
    if let Some(opt_val) = opt {
        params.insert("opt".to_string(), opt_val);
    }

    run_fs_query(&app, operations::STAT, json!(params), group, None).await
}

pub async fn get_hashsum(
    app: AppHandle,
    remote: String,
    path: String,
    hash_type: String,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("🔐 Getting hashsum for remote: {remote}, path: {path}, hash_type: {hash_type}");

    let fs_with_path = build_full_path(&remote, &path);
    let mut params = serde_json::Map::new();
    params.insert("fs".to_string(), json!(fs_with_path));
    params.insert("hashType".to_string(), json!(hash_type));

    run_fs_command_as_job(
        app,
        operations::HASHSUM,
        json!(params),
        JobMetadata::for_query(remote, fs_with_path, JobType::Hash, origin, group),
        None,
    )
    .await
}

pub async fn get_hashsum_file(
    app: AppHandle,
    remote: String,
    path: String,
    hash_type: String,
    origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("🔐 Getting hashsum file for remote: {remote}, path: {path}, hash_type: {hash_type}");

    let mut params = create_fs_params(&remote, Some(&path));
    params.insert("hashType".to_string(), json!(hash_type));
    let source = build_full_path(&remote, &path);

    run_fs_command_as_job(
        app,
        operations::HASHSUMFILE,
        json!(params),
        JobMetadata::for_query(remote, source, JobType::Hash, origin, group),
        None,
    )
    .await
}

pub async fn get_public_link(
    app: AppHandle,
    remote: String,
    path: String,
    options: Option<PublicLinkParams>,
    _origin: Option<crate::utils::types::origin::Origin>,
    group: Option<String>,
) -> Result<serde_json::Value, String> {
    debug!("🔗 Getting public link for remote: {remote}, path: {path}, options: {options:?}");

    let mut params = create_fs_params(&remote, Some(&path));

    if let Some(opts) = options {
        if let Some(unlink) = opts.unlink {
            params.insert("unlink".to_string(), json!(unlink));
        }
        if let Some(expire) = opts.expire {
            params.insert("expire".to_string(), json!(expire));
        }
    }

    run_fs_query(&app, operations::PUBLICLINK, json!(params), group, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_drive_path() {
        for (path, expected) in [
            ("/", "/"),
            ("/sdcard", "/storage/emulated/0"),
            ("/sdcard/Download", "/storage/emulated/0/Download"),
            ("Download", "/storage/emulated/0/Download"),
            ("Downloads", "/storage/emulated/0/Download"),
            ("Documents", "/storage/emulated/0/Documents"),
            ("/storage/emulated/0", "/storage/emulated/0"),
            ("/storage/1234-5678", "/storage/1234-5678"),
            ("/data/user/0/app", "/data/user/0/app"),
            ("", ""),
            ("   ", ""),
        ] {
            assert_eq!(normalize_drive_path(path, "android"), expected);
        }
        for (path, expected) in [
            ("C:", "C:\\"),
            (" d: ", "d:\\"),
            ("C:/Users/hakan/Arşiv", "C:\\Users\\hakan\\Arşiv"),
            (r"\\server\share", r"\\server\share"),
            ("", ""),
        ] {
            assert_eq!(normalize_drive_path(path, "windows"), expected);
        }
        for os in ["linux", "darwin"] {
            for path in ["/", "/sdcard", "/home/hakan", "C:", "Downloads"] {
                assert_eq!(normalize_drive_path(path, os), path);
            }
        }
    }

    #[test]
    fn home_labels_use_the_daemon_os() {
        for (path, os, expected) in [
            (r"C:\Users\hakan", "windows", true),
            ("D:/Users/Çağrı", "windows", true),
            (r"C:\Users\hakan\Downloads", "windows", false),
            ("/home/hakan", "linux", true),
            ("/Users/hakan", "darwin", true),
            ("/Users/hakan", "macos", true),
            ("/home/hakan", "windows", false),
            (r"C:\Users\hakan", "linux", false),
        ] {
            assert_eq!(is_home_directory(path, None, os), expected, "{path}");
        }
        assert!(!is_home_directory(
            "/srv/Hakan",
            Some("/srv/hakan"),
            "linux"
        ));
        assert!(is_home_directory(
            r"C:\Users\HAKAN",
            Some(r"C:\Users\hakan"),
            "windows"
        ));
    }

    struct QueryTransport {
        endpoint: &'static str,
        response: Option<serde_json::Value>,
        requests: std::sync::Mutex<Vec<serde_json::Value>>,
    }

    impl QueryTransport {
        fn new(endpoint: &'static str, response: Option<serde_json::Value>) -> Self {
            Self {
                endpoint,
                response,
                requests: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl RcloneTransport for QueryTransport {
        async fn kind(&self) -> crate::rclone::backend::transport::TransportKind {
            crate::rclone::backend::transport::TransportKind::HttpDaemon
        }

        async fn rpc(
            &self,
            endpoint: &str,
            payload: Option<&serde_json::Value>,
        ) -> Result<serde_json::Value, crate::rclone::backend::BackendError> {
            assert_eq!(endpoint, self.endpoint);
            self.requests
                .lock()
                .unwrap()
                .push(payload.cloned().unwrap_or_default());
            self.response
                .clone()
                .ok_or_else(|| crate::rclone::backend::BackendError::Other("unavailable".into()))
        }

        async fn read_file(
            &self,
            _: &str,
            _: &str,
            _: Option<(u64, Option<u64>)>,
        ) -> Result<
            Box<dyn tokio::io::AsyncRead + Unpin + Send>,
            crate::rclone::backend::BackendError,
        > {
            Err(crate::rclone::backend::BackendError::Other("unused".into()))
        }
    }

    #[tokio::test]
    async fn remote_windows_drives_keep_absolute_roots_and_no_host_metadata() {
        let transport = QueryTransport::new(
            core::DISKS,
            Some(json!({"disks": [
                r"C:\Users\hakan", "C:", r"C:\", "", 42, r"C:\Users\hakan\Downloads"
            ]})),
        );
        let drives = load_local_drives(&transport, "windows", false).await;
        assert_eq!(
            drives.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            [r"C:\Users\hakan", r"C:\", r"C:\Users\hakan\Downloads"]
        );
        assert_eq!(drives[0].label, "titlebar.home");
        assert_eq!(drives[1].label, "nautilus.titles.fileSystem");
        for drive in drives {
            assert_eq!(drive.total_space, 0);
            assert!(drive.file_system.is_empty());
        }
    }

    #[tokio::test]
    async fn unavailable_remote_disks_fall_back_to_the_daemon_os() {
        for os in ["windows", "linux", "android"] {
            for response in [
                None,
                Some(json!({"disks": []})),
                Some(json!({"disks": null})),
                Some(json!({"disks": ["", "   ", 42, null]})),
            ] {
                let transport = QueryTransport::new(core::DISKS, response);
                let drives = load_local_drives(&transport, os, false).await;
                let expected = match os {
                    "windows" => r"C:\",
                    "android" => "/storage/emulated/0",
                    _ => "/",
                };
                assert_eq!(drives.len(), 1);
                assert_eq!(drives[0].name, expected);
                assert_eq!(drives[0].total_space, 0);
            }
        }
    }

    #[tokio::test]
    async fn remote_posix_and_android_drives_do_not_use_host_normalization() {
        let linux = QueryTransport::new(core::DISKS, Some(json!({"disks": ["/", "/sdcard"]})));
        let drives = load_local_drives(&linux, "linux", false).await;
        assert_eq!(
            drives.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            ["/", "/sdcard"]
        );
        assert!(drives.iter().all(|d| d.total_space == 0));
        let android = QueryTransport::new(
            core::DISKS,
            Some(json!({"disks": ["Downloads", "/storage/1234"]})),
        );
        let drives = load_local_drives(&android, "android", false).await;
        assert_eq!(drives[0].name, "/storage/emulated/0");
        assert_eq!(drives[1].name, "/storage/emulated/0/Download");
    }

    #[tokio::test]
    async fn file_capacity_uses_daemon_metadata_and_target_path_rules() {
        for (root, path, windows, parent, name) in [
            (
                r"C:\Users\hakan",
                "ntuser.ini",
                true,
                "C:/Users/hakan",
                "ntuser.ini",
            ),
            (r"D:\", "file.txt", true, "D:/", "file.txt"),
            (
                r"\\server\share",
                "file.txt",
                true,
                "//server/share",
                "file.txt",
            ),
            ("/", "home/Arşiv/旅行.txt", false, "/home/Arşiv", "旅行.txt"),
        ] {
            let transport =
                QueryTransport::new(operations::STAT, Some(json!({"item": {"IsDir": false}})));
            assert_eq!(
                disk_usage_root(&transport, root, Some(path), windows)
                    .await
                    .unwrap(),
                parent
            );
            let requests = transport.requests.lock().unwrap();
            assert_eq!(requests[0]["fs"], parent);
            assert_eq!(requests[0]["remote"], name);
        }
    }

    #[tokio::test]
    async fn directory_capacity_keeps_the_requested_directory() {
        let transport =
            QueryTransport::new(operations::STAT, Some(json!({"item": {"IsDir": true}})));
        assert_eq!(
            disk_usage_root(&transport, "C:/", Some("mounted.volume"), true)
                .await
                .unwrap(),
            "C:/mounted.volume"
        );
        assert_eq!(
            disk_usage_root(&transport, "/", None, false).await.unwrap(),
            "/"
        );
    }

    #[tokio::test]
    async fn capacity_uses_windows_volume_roots_without_a_stat_listing() {
        for (root, expected) in [
            (r"C:\", "C:/"),
            (r"\\server\share", "//server/share"),
            (r"\\?\UNC\server\share", "//?/UNC/server/share"),
            (r"\\?\C:\", "//?/C:/"),
        ] {
            let transport = QueryTransport::new(operations::STAT, None);
            assert_eq!(
                disk_usage_root(&transport, root, None, true).await.unwrap(),
                expected
            );
            assert!(transport.requests.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn capacity_does_not_guess_when_daemon_metadata_is_unavailable() {
        for response in [None, Some(json!({"item": null})), Some(json!({"item": {}}))] {
            let transport = QueryTransport::new(operations::STAT, response);
            assert!(
                disk_usage_root(&transport, "C:/", Some("missing"), true)
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn cloud_capacity_uses_the_remote_root_without_local_stat() {
        let transport = QueryTransport::new(operations::STAT, None);
        for (remote, expected) in [
            ("drive:photos", "drive:"),
            ("C:photos", "C:"),
            (
                ":s3,endpoint='https://example.com':bucket/path",
                ":s3,endpoint='https://example.com':",
            ),
        ] {
            assert_eq!(
                disk_usage_root(&transport, remote, Some("file.txt"), false)
                    .await
                    .unwrap(),
                expected
            );
        }
        assert!(transport.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn capacity_rejects_malformed_filesystem_roots_before_rpc() {
        let transport = QueryTransport::new(operations::STAT, None);
        for remote in ["", "::invalid", ":s3,endpoint='unclosed:bucket"] {
            assert!(
                disk_usage_root(&transport, remote, None, false)
                    .await
                    .is_err()
            );
        }
        assert!(transport.requests.lock().unwrap().is_empty());
    }

    /// A one-backend app whose rc server answers the scripted `(status, body)` replies in order
    /// and records every request as `(path, body)`.
    async fn app_with_rc_server(
        replies: Vec<(u16, serde_json::Value)>,
    ) -> (
        AppHandle,
        tokio::task::JoinHandle<Vec<(String, serde_json::Value)>>,
        tempfile::TempDir,
    ) {
        use crate::rclone::backend::CopySources;
        use crate::services::settings::{AppSettingsManager, schema::AppSettings};
        use crate::utils::types::state::RcloneState;
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let directory = tempfile::tempdir().unwrap();
        let settings: AppSettingsManager = rcman::SettingsManager::builder("query-test", "1.0.0")
            .with_config_dir(directory.path())
            .with_schema::<AppSettings>()
            .with_sub_settings(rcman::SubSettingsConfig::new("remotes").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("backend").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("quick_runs").with_profiles())
            .with_sub_settings(rcman::SubSettingsConfig::singlefile("workflows").with_profiles())
            .build()
            .unwrap();
        let manager = BackendManager::new();
        manager
            .add(
                &settings,
                Backend::new_remote("A", "127.0.0.1", port),
                CopySources::default(),
            )
            .await
            .unwrap();
        manager.switch_to(&settings, "A").await.unwrap();
        let app = AppHandle::default();
        app.manage(manager);
        app.manage(settings);
        app.manage(RcloneState::new(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(2))
                .build()
                .unwrap(),
            Arc::new(RoutingTransport::new(app.clone())),
        ));

        let server = crate::utils::spawn(async move {
            let mut requests = Vec::new();
            for (status, reply) in replies {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let (header_end, length) = loop {
                    let mut buffer = [0u8; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                    if let Some(index) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..index]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        break (index + 4, length);
                    }
                };
                while request.len() < header_end + length {
                    let mut buffer = [0u8; 4096];
                    let count = stream.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&buffer[..count]);
                }
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let path = headers.split_whitespace().nth(1).unwrap().to_string();
                let payload = if length == 0 {
                    json!({})
                } else {
                    serde_json::from_slice(&request[header_end..]).unwrap()
                };
                requests.push((path, payload));
                let reply = reply.to_string();
                let reason = if status == 200 { "OK" } else { "Error" };
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                            reply.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            }
            requests
        });
        (app, server, directory)
    }

    #[tokio::test]
    async fn a_metadata_query_is_one_direct_rc_call_that_keeps_its_group() {
        let (app, server, _directory) =
            app_with_rc_server(vec![(200, json!({"item": {"IsDir": true}}))]).await;

        let stat = get_stat(
            app,
            "gdrive:".into(),
            "dir".into(),
            None,
            None,
            Some("filemanager-read".into()),
        )
        .await
        .unwrap();

        assert_eq!(stat, json!({"item": {"IsDir": true}}));
        let requests = server.await.unwrap();
        assert_eq!(
            requests.len(),
            1,
            "a query must not poll a job: {requests:?}"
        );
        let (path, body) = &requests[0];
        assert_eq!(path, "/operations/stat");
        assert_eq!(body["fs"], "gdrive:");
        assert_eq!(body["remote"], "dir");
        assert_eq!(body["_group"], "filemanager-read");
        assert!(body.get("_async").is_none(), "{body}");
    }

    #[tokio::test]
    async fn a_query_without_a_group_sends_none() {
        let (app, server, _directory) = app_with_rc_server(vec![(200, json!({"list": []}))]).await;

        let listing = get_remote_paths(app, "gdrive:".into(), Some("dir".into()), None, None, None)
            .await
            .unwrap();

        assert_eq!(listing, json!({"list": []}));
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "/operations/list");
        assert!(requests[0].1.get("_group").is_none(), "{}", requests[0].1);
    }

    #[tokio::test]
    async fn a_failed_query_reports_the_mapped_rclone_error() {
        let (app, server, _directory) = app_with_rc_server(vec![(
            500,
            json!({"error": "directory not found", "status": 500, "path": "operations/list", "input": {}}),
        )])
        .await;

        let error = get_remote_paths(app, "gdrive:".into(), Some("gone".into()), None, None, None)
            .await
            .unwrap_err();

        // The same mapping a failed job went through.
        assert_eq!(error, "backendErrors.remote.notFound");
        assert_eq!(server.await.unwrap().len(), 1);
    }
}
