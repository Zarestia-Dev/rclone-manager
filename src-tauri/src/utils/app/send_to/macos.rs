use crate::utils::app::send_to::common::{apply_template, get_home_dir};
use std::path::{Path, PathBuf};

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn register(
    remote: &str,
    path_val: &str,
    name: &str,
    current_exe: &Path,
) -> Result<(), String> {
    let home = get_home_dir()?;
    let workflow_dir = home.join(format!("Library/Services/{name}.workflow"));
    let contents_dir = workflow_dir.join("Contents");
    std::fs::create_dir_all(&contents_dir)
        .map_err(|e| format!("Failed to create workflow bundle directories: {e}"))?;

    // 1. Info.plist
    let info_uuid = uuid::Uuid::new_v4().to_string().replace('-', "");
    let escaped_name = escape_xml(name);
    let info_content = apply_template(
        include_str!("../../../../resources/send_to/macos_info.plist"),
        &[
            ("uuid", info_uuid.as_str()),
            ("name", escaped_name.as_str()),
        ],
    );
    std::fs::write(contents_dir.join("Info.plist"), info_content)
        .map_err(|e| format!("Failed to write Info.plist: {e}"))?;

    // 2. document.wflow
    let current_exe_str = current_exe.to_string_lossy();
    let cmd_string = format!(
        "exec \"{current_exe_str}\" --send-to-remote \"{remote}\" --send-to-path \"{path_val}\" \"$@\""
    );
    let cmd_string_escaped = escape_xml(&cmd_string);
    let input_uuid = uuid::Uuid::new_v4().to_string().to_uppercase();
    let output_uuid = uuid::Uuid::new_v4().to_string().to_uppercase();
    let action_uuid = uuid::Uuid::new_v4().to_string().to_uppercase();

    let doc_content = apply_template(
        include_str!("../../../../resources/send_to/macos_document.wflow"),
        &[
            ("cmd_string", cmd_string_escaped.as_str()),
            ("input_uuid", input_uuid.as_str()),
            ("output_uuid", output_uuid.as_str()),
            ("action_uuid", action_uuid.as_str()),
        ],
    );
    std::fs::write(contents_dir.join("document.wflow"), doc_content)
        .map_err(|e| format!("Failed to write document.wflow: {e}"))?;

    Ok(())
}

pub fn unregister(name: &str) -> Result<(), String> {
    let home = get_home_dir()?;
    let workflow_dir = home.join(format!("Library/Services/{name}.workflow"));
    if workflow_dir.exists() {
        std::fs::remove_dir_all(workflow_dir)
            .map_err(|e| format!("Failed to delete workflow bundle: {e}"))?;
    }
    Ok(())
}

pub fn is_registered(name: &str) -> Result<bool, String> {
    let home = get_home_dir()?;
    Ok(home
        .join(format!("Library/Services/{name}.workflow"))
        .exists())
}
