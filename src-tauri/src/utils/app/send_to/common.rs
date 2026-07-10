const INVALID_NAME_CHARS: &str = r#"<>:"/\|?*"#;

pub fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if INVALID_NAME_CHARS.contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect()
}

pub fn get_sanitized_name(remote: &str, path: Option<&str>) -> String {
    let path_suffix = path
        .filter(|p| !p.is_empty() && *p != "/")
        .map(|p| {
            format!(
                " - {}",
                p.trim_start_matches('/').replace(['/', '\\'], " - ")
            )
        })
        .unwrap_or_default();

    let app_suffix = if cfg!(feature = "web-server") {
        " (RClone Manager Headless)"
    } else {
        " (RClone Manager)"
    };

    sanitize_name(&format!("{remote}{path_suffix}{app_suffix}"))
}

pub fn apply_template(template: &str, replacements: &[(&str, &str)]) -> String {
    let mut content = template.to_string();
    for &(key, value) in replacements {
        content = content.replace(&format!("{{{key}}}"), value);
    }
    content
}

#[cfg(unix)]
pub fn get_home_dir() -> Result<std::path::PathBuf, String> {
    std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .map_err(|_| "Could not find HOME environment variable".to_string())
}
