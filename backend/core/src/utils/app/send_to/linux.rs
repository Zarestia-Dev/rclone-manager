use crate::utils::app::send_to::common::{
    apply_template, get_home_dir, is_named_for, send_to_arguments,
};
use std::path::{Path, PathBuf};

struct LinuxPaths {
    nautilus: PathBuf,
    nautilus_python: PathBuf,
    dolphin: PathBuf,
    nemo: PathBuf,
}

impl LinuxPaths {
    fn new(home: &Path) -> Self {
        Self {
            nautilus: home.join(".local/share/nautilus/scripts"),
            nautilus_python: home.join(".local/share/nautilus-python/extensions"),
            dolphin: home.join(".local/share/kio/servicemenus"),
            nemo: home.join(".local/share/nemo/actions"),
        }
    }
}

fn write_executable(path: &Path, content: &str) -> std::io::Result<()> {
    std::fs::write(path, content)?;
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(crate::utils::constants::EXEC_MODE);
        std::fs::set_permissions(path, perms)?;
    }
    Ok(())
}

fn install_template(
    directory: &Path,
    filename: &str,
    template: &str,
    replacements: &[(&str, &str)],
    make_executable: bool,
) {
    if std::fs::create_dir_all(directory).is_ok() {
        let content = apply_template(template, replacements);
        let path = directory.join(filename);
        if make_executable {
            let _ = write_executable(&path, &content);
        } else {
            let _ = std::fs::write(&path, content);
        }
    }
}

pub async fn register(
    remote: &str,
    path_val: &str,
    name: &str,
    current_exe: &Path,
    product: &crate::context::ProductInfo,
) -> Result<(), String> {
    let home = get_home_dir()?;
    let paths = LinuxPaths::new(&home);
    let exec_path = if cfg!(feature = "flatpak") {
        let app_id = std::env::var("FLATPAK_ID").unwrap_or_else(|_| product.flatpak_id.to_string());
        format!("flatpak run {app_id}")
    } else {
        format!("\"{}\"", current_exe.to_string_lossy())
    };

    // 1. Nautilus script
    install_template(
        &paths.nautilus,
        name,
        include_str!("../../../../resources/send_to/nautilus_script.sh"),
        &[
            ("exec_path", &exec_path),
            ("remote", remote),
            ("path", path_val),
        ],
        true,
    );

    // 2. Nautilus Python extension
    let uuid = uuid::Uuid::new_v4().to_string().replace('-', "");
    let class_name = format!("RCloneManagerExtension_{uuid}");
    install_template(
        &paths.nautilus_python,
        &format!("{name}.py"),
        include_str!("../../../../resources/send_to/nautilus_extension.py"),
        &[
            ("class_name", &class_name),
            ("exec_path", &exec_path),
            ("remote", remote),
            ("path", path_val),
            ("uuid", &uuid),
            ("name", name),
        ],
        false,
    );

    // 3. Dolphin
    install_template(
        &paths.dolphin,
        &format!("{name}.desktop"),
        include_str!("../../../../resources/send_to/dolphin_action.desktop"),
        &[
            ("name", name),
            ("exec_path", &exec_path),
            ("remote", remote),
            ("path", path_val),
        ],
        true,
    );

    // 4. Nemo
    install_template(
        &paths.nemo,
        &format!("{name}.nemo_action"),
        include_str!("../../../../resources/send_to/nemo_action.nemo_action"),
        &[
            ("name", name),
            ("exec_path", &exec_path),
            ("remote", remote),
            ("path", path_val),
        ],
        true,
    );

    Ok(())
}

pub fn unregister(name: &str, _product: &crate::context::ProductInfo) -> Result<(), String> {
    let home = get_home_dir()?;
    let paths = LinuxPaths::new(&home);

    let _ = std::fs::remove_file(paths.nautilus.join(name));
    let _ = std::fs::remove_file(paths.nautilus_python.join(format!("{name}.py")));
    let _ = std::fs::remove_file(paths.dolphin.join(format!("{name}.desktop")));
    let _ = std::fs::remove_file(paths.nemo.join(format!("{name}.nemo_action")));

    Ok(())
}

/// The entries a product called `display_name` registered: name, remote and path.
pub fn entries_named(
    display_name: &str,
    _product: &crate::context::ProductInfo,
) -> Vec<(String, String, String)> {
    get_home_dir()
        .map(|home| entries_named_in(&LinuxPaths::new(&home), display_name))
        .unwrap_or_default()
}

/// The Nautilus extension is skipped: it lists its arguments as separate strings,
/// and the other three files of the same entry carry them too.
fn entries_named_in(paths: &LinuxPaths, display_name: &str) -> Vec<(String, String, String)> {
    let mut entries: Vec<(String, String, String)> = Vec::new();
    for (directory, extension) in [
        (&paths.nautilus, ""),
        (&paths.dolphin, ".desktop"),
        (&paths.nemo, ".nemo_action"),
    ] {
        let Ok(files) = std::fs::read_dir(directory) else {
            continue;
        };
        for file in files.flatten() {
            let file_name = file.file_name().to_string_lossy().into_owned();
            let Some(name) = file_name.strip_suffix(extension) else {
                continue;
            };
            if !is_named_for(name, display_name) || entries.iter().any(|(known, ..)| known == name)
            {
                continue;
            }
            let arguments = std::fs::read_to_string(file.path())
                .ok()
                .as_deref()
                .and_then(send_to_arguments);
            if let Some((remote, path)) = arguments {
                entries.push((name.to_string(), remote, path));
            }
        }
    }
    entries
}

pub fn is_registered(name: &str, _product: &crate::context::ProductInfo) -> Result<bool, String> {
    let home = get_home_dir()?;
    let paths = LinuxPaths::new(&home);

    Ok(paths.nautilus.join(name).exists()
        || paths.nautilus_python.join(format!("{name}.py")).exists()
        || paths.dolphin.join(format!("{name}.desktop")).exists()
        || paths.nemo.join(format!("{name}.nemo_action")).exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_of_a_former_product_name_are_found_once_with_their_arguments() {
        let home = tempfile::tempdir().unwrap();
        let paths = LinuxPaths::new(home.path());
        for directory in [&paths.nautilus, &paths.dolphin, &paths.nemo] {
            std::fs::create_dir_all(directory).unwrap();
        }
        let old = "gdrive - a (RClone Manager Headless)";
        let arguments = r#"--send-to-remote "gdrive" --send-to-path "a""#;
        std::fs::write(paths.nautilus.join(old), format!("exec /x {arguments}")).unwrap();
        std::fs::write(paths.nemo.join(format!("{old}.nemo_action")), arguments).unwrap();
        // Dolphin's file alone still counts, and another product's entry does not.
        let dolphin_only = "photos (RClone Manager Headless)";
        std::fs::write(
            paths.dolphin.join(format!("{dolphin_only}.desktop")),
            r#"Exec=/x --send-to-remote "photos" --send-to-path "" %F"#,
        )
        .unwrap();
        std::fs::write(paths.nautilus.join("gdrive (RClone Manager)"), arguments).unwrap();

        let mut found = entries_named_in(&paths, "RClone Manager Headless");
        found.sort();
        assert_eq!(
            found,
            [
                (old.to_string(), "gdrive".to_string(), "a".to_string()),
                (
                    dolphin_only.to_string(),
                    "photos".to_string(),
                    String::new()
                ),
            ]
        );
        assert!(entries_named_in(&LinuxPaths::new(&home.path().join("none")), "x").is_empty());
    }
}
