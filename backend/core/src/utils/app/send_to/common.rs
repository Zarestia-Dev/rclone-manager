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

pub fn get_sanitized_name(remote: &str, path: Option<&str>, display_name: &str) -> String {
    let path_suffix = path
        .filter(|p| !p.is_empty() && *p != "/")
        .map(|p| {
            format!(
                " - {}",
                p.trim_start_matches('/').replace(['/', '\\'], " - ")
            )
        })
        .unwrap_or_default();

    sanitize_name(&format!("{remote}{path_suffix} ({display_name})"))
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

#[cfg(test)]
mod tests {
    use super::get_sanitized_name;

    #[test]
    fn send_to_names_preserve_each_products_existing_shortcuts() {
        for suffix in ["RClone Manager", "RClone Manager Headless"] {
            for path in [None, Some(""), Some("/")] {
                assert_eq!(
                    get_sanitized_name("remote", path, suffix),
                    format!("remote ({suffix})")
                );
            }
            assert_eq!(
                get_sanitized_name("r:ö", Some("/a/b"), suffix),
                format!("r-ö - a - b ({suffix})")
            );
        }
    }
}
