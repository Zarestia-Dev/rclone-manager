use tauri::image::Image;

const ICON_NORMAL: &[u8] = include_bytes!("../../../icons/rclone_symbolic.png");
const ICON_ACTIVE: &[u8] = include_bytes!("../../../icons/rclone_symbolic_active.png");

/// Returns the tray icon image based on the active state.
/// This centralizes the binary data embedding so it's only done once.
pub fn get_icon(is_active: bool) -> tauri::Result<Image<'static>> {
    let bytes = if is_active { ICON_ACTIVE } else { ICON_NORMAL };
    Image::from_bytes(bytes)
}
