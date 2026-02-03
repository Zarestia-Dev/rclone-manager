use std::ffi::OsStr;
use std::process::Stdio;

/// A wrapper around `tokio::process::Command` that mimics `tauri_plugin_shell`'s API
/// but allows us to safely set platform-specific flags (like CREATE_NO_WINDOW)
/// without declaring them everywhere.
#[derive(Debug)]
pub struct Command {
    inner: tokio::process::Command,
}

impl Command {
    pub fn new<S: AsRef<OsStr>>(program: S) -> Self {
        let mut cmd = tokio::process::Command::new(program);

        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::piped());

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        Self { inner: cmd }
    }

    pub fn arg<S: AsRef<OsStr>>(mut self, arg: S) -> Self {
        self.inner.arg(arg);
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.inner.args(args);
        self
    }

    pub fn env<K, V>(mut self, key: K, value: V) -> Self
    where
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.inner.env(key, value);
        self
    }

    pub fn envs<I, K, V>(mut self, envs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        self.inner.envs(envs);
        self
    }

    // pub fn current_dir<P: AsRef<std::path::Path>>(mut self, dir: P) -> Self {
    //     self.inner.current_dir(dir);
    //     self
    // }

    pub fn spawn(mut self) -> std::io::Result<tokio::process::Child> {
        self.inner.spawn()
    }

    pub async fn output(mut self) -> std::io::Result<std::process::Output> {
        self.inner.output().await
    }
}
