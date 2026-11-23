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

/// A registered Send To entry: its name, and the remote and path it sends to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Entry {
    pub name: String,
    pub remote: String,
    pub path: String,
}

/// Whether `name` is the name of an entry of the product called `display_name`.
pub fn is_named_for(name: &str, display_name: &str) -> bool {
    name.ends_with(&format!(" ({display_name})"))
}

/// The remote and path an entry passes: `--send-to-remote "<remote>" --send-to-path "<path>"`.
pub fn send_to_arguments(text: &str) -> Option<(String, String)> {
    let quoted = |flag: &str| {
        let prefix = format!("{flag} \"");
        let start = text.find(&prefix)? + prefix.len();
        let length = text[start..].find('"')?;
        Some(text[start..start + length].to_string())
    };
    Some((quoted("--send-to-remote")?, quoted("--send-to-path")?))
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
    use super::{get_sanitized_name, is_named_for, send_to_arguments};

    #[test]
    fn send_to_names_preserve_each_products_existing_shortcuts() {
        for suffix in ["RClone Manager", "RClone Manager Server"] {
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

    #[test]
    fn entries_are_told_apart_by_the_product_name_they_end_with() {
        let name = get_sanitized_name("gdrive", Some("/a"), "RClone Manager Headless");
        assert!(is_named_for(&name, "RClone Manager Headless"));
        assert!(!is_named_for(&name, "RClone Manager"));
        assert!(!is_named_for(
            "RClone Manager Headless",
            "RClone Manager Headless"
        ));
    }

    #[test]
    fn the_arguments_of_every_entry_format_are_read() {
        for text in [
            "#!/bin/bash\nexec \"/usr/bin/x\" --send-to-remote \"gdrive\" --send-to-path \"a/b c\" \"$@\"",
            "Exec=/usr/bin/x --send-to-remote \"gdrive\" --send-to-path \"a/b c\" %F",
            r#""C:\x.exe" --send-to-remote "gdrive" --send-to-path "a/b c" "%1""#,
        ] {
            assert_eq!(
                send_to_arguments(text),
                Some(("gdrive".to_string(), "a/b c".to_string()))
            );
        }
        assert_eq!(
            send_to_arguments("--send-to-remote \"gdrive\" --send-to-path \"\""),
            Some(("gdrive".to_string(), String::new()))
        );
        // The Python extension lists them as separate strings, and other files have none.
        for text in [
            r#"["--send-to-remote", "gdrive", "--send-to-path", ""]"#,
            "",
            "--send-to-remote \"open",
        ] {
            assert_eq!(send_to_arguments(text), None);
        }
    }
}
