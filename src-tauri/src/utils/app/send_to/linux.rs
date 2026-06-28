use crate::utils::app::send_to::common::{apply_template, get_home_dir};
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o755);
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

pub fn register(
    remote: &str,
    path_val: &str,
    name: &str,
    current_exe: &Path,
) -> Result<(), String> {
    let home = get_home_dir()?;
    let paths = LinuxPaths::new(&home);
    let exec_path = if cfg!(feature = "flatpak") {
        let app_id = std::env::var("FLATPAK_ID")
            .unwrap_or_else(|_| crate::utils::app::platform::APP_ID.to_string());
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

pub fn unregister(name: &str) -> Result<(), String> {
    let home = get_home_dir()?;
    let paths = LinuxPaths::new(&home);

    let _ = std::fs::remove_file(paths.nautilus.join(name));
    let _ = std::fs::remove_file(paths.nautilus_python.join(format!("{name}.py")));
    let _ = std::fs::remove_file(paths.dolphin.join(format!("{name}.desktop")));
    let _ = std::fs::remove_file(paths.nemo.join(format!("{name}.nemo_action")));

    Ok(())
}

pub fn is_registered(name: &str) -> Result<bool, String> {
    let home = get_home_dir()?;
    let paths = LinuxPaths::new(&home);

    Ok(paths.nautilus.join(name).exists()
        || paths.nautilus_python.join(format!("{name}.py")).exists()
        || paths.dolphin.join(format!("{name}.desktop")).exists()
        || paths.nemo.join(format!("{name}.nemo_action")).exists())
}
