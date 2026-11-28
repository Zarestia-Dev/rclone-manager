use std::ffi::OsStr;
use std::process::Stdio;

/// A command with the output handling and platform flags every spawned process
/// shares: piped stdio, killed on drop, and no console window on Windows.
pub fn command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
}

/// `text` as one single-quoted word for `sh`.
#[cfg(any(target_os = "macos", test))]
pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// The AppleScript that runs `shell_command` as root. macOS asks the user for the
/// password in its own dialog; it never reaches this process.
#[cfg(any(target_os = "macos", test))]
pub fn as_administrator(shell_command: &str) -> String {
    let escaped = shell_command.replace('\\', "\\\\").replace('"', "\\\"");
    format!("do shell script \"{escaped}\" with administrator privileges")
}

/// What a failed `osascript` run means for the user. Error -128 is the password
/// dialog being dismissed, which is no failure to report as one.
#[cfg(any(target_os = "macos", test))]
pub fn osascript_error(stderr: &str) -> String {
    if stderr.contains("(-128)") {
        crate::localized_error!("backendErrors.updater.authorizationDenied")
    } else {
        stderr.trim().to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_words_survive_quotes_spaces_and_dollar_signs() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("It's $HOME"), r"'It'\''s $HOME'");
        // The shell reads the word back as the same text.
        #[cfg(unix)]
        for text in ["It's $HOME", "a \"b\" \\c", "", "two  spaces"] {
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("printf %s {}", shell_quote(text)))
                .output()
                .unwrap();
            assert_eq!(String::from_utf8(out.stdout).unwrap(), text);
        }
    }

    #[test]
    fn administrator_scripts_escape_what_applescript_would_read_as_syntax() {
        assert_eq!(
            as_administrator(r#"mv 'a "b" \c' d"#),
            r#"do shell script "mv 'a \"b\" \\c' d" with administrator privileges"#
        );
    }

    #[test]
    fn a_dismissed_password_dialog_is_reported_as_such() {
        let dismissed = "execution error: User canceled. (-128)\n";
        assert_eq!(
            osascript_error(dismissed),
            "backendErrors.updater.authorizationDenied"
        );
        assert_eq!(osascript_error(" not allowed \n"), "not allowed");
    }
}
