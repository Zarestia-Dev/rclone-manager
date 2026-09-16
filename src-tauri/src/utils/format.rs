//! Formatting utilities for file sizes, speeds, and display strings.

/// Formats a byte count into a human-readable string (e.g. 1.25 MiB).
///
/// Uses binary units (KiB, MiB, GiB, TiB with 1024 base) matching Rclone conventions.
#[must_use]
pub fn format_file_size(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;
    const GIB: u64 = 1024 * MIB;
    const TIB: u64 = 1024 * GIB;

    if bytes >= TIB {
        format!("{:.2} TiB", bytes as f64 / TIB as f64)
    } else if bytes >= GIB {
        format!("{:.2} GiB", bytes as f64 / GIB as f64)
    } else if bytes >= MIB {
        format!("{:.2} MiB", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.2} KiB", bytes as f64 / KIB as f64)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_file_size() {
        assert_eq!(format_file_size(500), "500 B");
        assert_eq!(format_file_size(1024), "1.00 KiB");
        assert_eq!(format_file_size(1048576), "1.00 MiB");
        assert_eq!(format_file_size(1073741824), "1.00 GiB");
        assert_eq!(format_file_size(1099511627776), "1.00 TiB");
    }
}
