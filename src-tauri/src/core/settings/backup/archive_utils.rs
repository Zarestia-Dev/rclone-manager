use std::{path::Path, process::Command};

/// **Archive Utilities for Backup Operations**
///
/// This module provides utilities for handling different archive formats:
/// - 7z executable detection
/// - Archive encryption detection
/// - Cross-platform compatibility
///   **Find 7z executable across different platforms**
pub fn find_7z_executable() -> Result<String, String> {
    // Try common 7z executable names
    for cmd in ["7z", "7za", "7z.exe", "7za.exe"] {
        if which::which(cmd).is_ok() {
            return Ok(cmd.to_string());
        }
    }

    // Platform-specific paths
    #[cfg(target_os = "windows")]
    {
        let common_paths = [
            r"C:\Program Files\7-Zip\7z.exe",
            r"C:\Program Files (x86)\7-Zip\7z.exe",
            r"C:\tools\7zip\7z.exe",
        ];

        for path in common_paths.iter() {
            if Path::new(path).exists() {
                return Ok(path.to_string());
            }
        }

        // if let Ok(hklm) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("SOFTWARE\\7-Zip") {
        //     if let Ok(install_path) = hklm.get_value::<String, _>("Path") {
        //         let exe_path = format!("{}\\7z.exe", install_path);
        //         if Path::new(&exe_path).exists() {
        //             return Ok(exe_path);
        //         }
        //     }
        // }
    }

    #[cfg(target_os = "macos")]
    {
        let common_paths = [
            "/usr/local/bin/7z",
            "/opt/homebrew/bin/7z",
            "/Applications/Keka.app/Contents/Resources/keka7z",
        ];

        for path in common_paths.iter() {
            if Path::new(path).exists() {
                return Ok(path.to_string());
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let common_paths = ["/usr/bin/7z", "/usr/local/bin/7z", "/snap/bin/7z"];

        for path in common_paths.iter() {
            if Path::new(path).exists() {
                return Ok(path.to_string());
            }
        }
    }

    Err("7z executable not found. Please install 7-Zip.".into())
}

/// **Check if a 7z archive is encrypted**
pub fn is_7z_encrypted(path: &Path) -> Result<bool, String> {
    let seven_zip =
        find_7z_executable().map_err(|e| format!("Failed to find 7z executable: {e}"))?;

    let output = Command::new(seven_zip)
        .arg("l") // List contents
        .arg("-slt") // Show technical information
        .arg(path)
        .output()
        .map_err(|e| format!("Failed to run 7z: {e}"))?;

    if !output.status.success() {
        // If listing fails, it might be encrypted
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("Wrong password") || stderr.contains("Cannot open encrypted archive") {
            return Ok(true);
        }
        return Ok(true); // Assume encrypted if we can't read it
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Check for encryption indicators
    if stdout.contains("Encrypted = +") || stdout.contains("Method = ") && stdout.contains("AES") {
        Ok(true)
    } else {
        Ok(false)
    }
}

// **Verify 7z executable functionality**
// pub fn verify_7z_functionality() -> Result<String, String> {
//     let seven_zip = find_7z_executable()?;

//     let output = Command::new(&seven_zip)
//         .arg("--help")
//         .output()
//         .map_err(|e| format!("Failed to test 7z executable: {}", e))?;

//     if output.status.success() {
//         let stdout = String::from_utf8_lossy(&output.stdout);
//         // Extract version information if available
//         for line in stdout.lines() {
//             if line.contains("7-Zip") {
//                 return Ok(format!("7z executable found: {}", line.trim()));
//             }
//         }
//         Ok(format!("7z executable working: {}", seven_zip))
//     } else {
//         Err(format!("7z executable not working: {}", seven_zip))
//     }
// }
