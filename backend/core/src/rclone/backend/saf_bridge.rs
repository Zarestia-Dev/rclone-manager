static JAVA_VM: std::sync::OnceLock<jni::JavaVM> = std::sync::OnceLock::new();
static BRIDGE_CLASS: std::sync::OnceLock<jni::objects::Global<jni::objects::JClass>> =
    std::sync::OnceLock::new();

#[cfg(feature = "updater")]
pub fn install_update_apk(path: &str) -> Result<i32, String> {
    let vm = JAVA_VM.get().ok_or("Java VM not initialized")?;
    let cls = BRIDGE_CLASS.get().ok_or("Android bridge not initialized")?;
    vm.attach_current_thread(|env| {
        use jni::{jni_sig, jni_str};
        let path = env.new_string(path)?;
        let cls: &jni::objects::JClass = cls.as_ref();
        let result = env.call_static_method(
            cls,
            jni_str!("installUpdateApk"),
            jni_sig!("(Ljava/lang/String;)I"),
            &[(&path).into()],
        );
        match result {
            Ok(result) => result.i(),
            Err(error) => {
                env.exception_clear();
                Err(error)
            }
        }
    })
    .map_err(|e| e.to_string())
}

fn cache_java_vm(env: &mut jni::Env) {
    if JAVA_VM.get().is_none()
        && let Ok(vm) = env.get_java_vm()
    {
        let _ = JAVA_VM.set(vm);
    }
    if BRIDGE_CLASS.get().is_none() {
        use jni::jni_str;
        if let Ok(cls) = env.find_class(jni_str!("com/rclone/manager/RcloneSafBridge")) {
            if let Ok(global) = env.new_global_ref(&cls) {
                let _ = BRIDGE_CLASS.set(global);
            }
        } else {
            env.exception_clear();
        }
    }
}

/// Runs `call` against the cached `RcloneSafBridge` class. `None` when the bridge is not
/// initialized yet or the call failed; a Java exception the call raised is cleared.
fn with_bridge<R>(
    call: impl FnOnce(&mut jni::Env, &jni::objects::JClass) -> Result<R, jni::errors::Error>,
) -> Option<R> {
    let (vm, cls) = (JAVA_VM.get()?, BRIDGE_CLASS.get()?);
    vm.attach_current_thread(|env| {
        let result = call(env, cls.as_ref());
        if result.is_err() {
            env.exception_clear();
        }
        result
    })
    .ok()
}

pub fn is_network_metered() -> bool {
    with_bridge(|env, cls| {
        use jni::{jni_sig, jni_str};
        env.call_static_method(cls, jni_str!("isNetworkMetered"), jni_sig!("()Z"), &[])?
            .z()
    })
    .unwrap_or(false)
}

/// Registers the Android network callback that reports metered changes to
/// `utils::io::network::on_metered_changed`.
pub fn start_network_monitor() -> bool {
    with_bridge(|env, cls| {
        use jni::{jni_sig, jni_str};
        env.call_static_method(cls, jni_str!("startNetworkMonitor"), jni_sig!("()Z"), &[])?
            .z()
    })
    .unwrap_or(false)
}

/// Stops keep-alive and finishes the activity for a user quit, so Tauri's event loop
/// sees the window destroyed and ends the process.
pub fn request_quit() {
    with_bridge(|env, cls| {
        use jni::{jni_sig, jni_str};
        env.call_static_method(cls, jni_str!("requestQuit"), jni_sig!("()V"), &[])
            .map(|_| ())
    });
}

pub fn notify_roots_changed() {
    with_bridge(|env, cls| {
        use jni::{jni_sig, jni_str};
        env.call_static_method(cls, jni_str!("notifyRootsChanged"), jni_sig!("()V"), &[])
            .map(|_| ())
    });
}

pub fn update_mounted_remotes(remotes: &[crate::utils::types::remotes::MountedRemote]) {
    let json_str = serde_json::to_string(remotes).unwrap_or_else(|_| "[]".to_string());
    with_bridge(|env, cls| {
        use jni::{jni_sig, jni_str};
        let jstr = env.new_string(&json_str)?;
        env.call_static_method(
            cls,
            jni_str!("updateMountedRemotes"),
            jni_sig!("(Ljava/lang/String;)V"),
            &[(&jstr).into()],
        )
        .map(|_| ())
    });
}

pub fn open_saf_remote(remote_name: &str) -> bool {
    open_with_string_arg(remote_name, |env, cls, arg| {
        use jni::{jni_sig, jni_str};
        env.call_static_method(
            cls,
            jni_str!("openSafRemote"),
            jni_sig!("(Ljava/lang/String;)Z"),
            &[arg.into()],
        )?
        .z()
    })
}

pub fn open_local_path(path: &str) -> bool {
    open_with_string_arg(path, |env, cls, arg| {
        use jni::{jni_sig, jni_str};
        env.call_static_method(
            cls,
            jni_str!("openLocalPath"),
            jni_sig!("(Ljava/lang/String;)Z"),
            &[arg.into()],
        )?
        .z()
    })
}

/// Calls a bridge method that takes one string and reports whether it opened something.
fn open_with_string_arg(
    value: &str,
    call: impl FnOnce(
        &mut jni::Env,
        &jni::objects::JClass,
        &jni::objects::JString,
    ) -> Result<bool, jni::errors::Error>,
) -> bool {
    with_bridge(|env, cls| {
        let arg = env.new_string(value)?;
        call(env, cls, &arg)
    })
    .unwrap_or(false)
}

pub fn open_content_uri_fd(uri_str: &str, mode: &str) -> Result<std::os::fd::RawFd, String> {
    let Some(vm) = JAVA_VM.get() else {
        return Err("Java VM not initialized".to_string());
    };
    let Some(g_cls) = BRIDGE_CLASS.get() else {
        return Err("RcloneSafBridge class not cached".to_string());
    };
    let mut raw_fd: i32 = -1;
    let attach_res = vm.attach_current_thread(|env| {
        use jni::{jni_sig, jni_str};
        let cls: &jni::objects::JClass = g_cls.as_ref();
        let j_uri = env.new_string(uri_str)?;
        let j_mode = env.new_string(mode)?;
        let res = env.call_static_method(
            cls,
            jni_str!("openContentUriFd"),
            jni_sig!("(Ljava/lang/String;Ljava/lang/String;)I"),
            &[(&j_uri).into(), (&j_mode).into()],
        )?;
        raw_fd = res.i()?;
        Ok::<(), jni::errors::Error>(())
    });

    if let Err(e) = attach_res {
        return Err(format!("JNI error opening content URI: {e}"));
    }

    if raw_fd < 0 {
        return Err(format!("Failed to open content URI fd for {uri_str}"));
    }

    Ok(raw_fd)
}

/// Posts a regular notification from Kotlin, which works with or without an activity.
pub fn show_notification(title: &str, body: &str) -> bool {
    with_bridge(|env, cls| {
        use jni::{jni_sig, jni_str};
        let title = env.new_string(title)?;
        let body = env.new_string(body)?;
        env.call_static_method(
            cls,
            jni_str!("showNotification"),
            jni_sig!("(Ljava/lang/String;Ljava/lang/String;)V"),
            &[(&title).into(), (&body).into()],
        )
        .map(|_| ())
    })
    .is_some()
}

/// Tells the foreground service what is running so it can start, stop and refresh its
/// notification, and stores the start-on-boot choice for the boot receiver, which runs before
/// any native code can read the settings. `text` is the already translated summary.
pub fn sync_keep_alive(
    keep_alive: bool,
    start_on_boot: bool,
    jobs: usize,
    mounts: usize,
    serves: usize,
    text: &str,
) {
    with_bridge(|env, cls| {
        use jni::{jni_sig, jni_str, objects::JValue};
        let text = env.new_string(text)?;
        env.call_static_method(
            cls,
            jni_str!("syncKeepAlive"),
            jni_sig!("(ZZIIILjava/lang/String;)V"),
            &[
                JValue::Bool(keep_alive),
                JValue::Bool(start_on_boot),
                JValue::Int(jobs as i32),
                JValue::Int(mounts as i32),
                JValue::Int(serves as i32),
                (&text).into(),
            ],
        )
        .map(|_| ())
    });
}

mod jni_impl {
    use jni::EnvUnowned;
    use jni::objects::JClass;
    use jni::sys::jstring;

    use crate::rclone::backend::rclone_ffi;

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn Java_com_rclone_manager_RcloneSafBridge_nativeInitSaf<'local>(
        mut env_unowned: EnvUnowned<'local>,
        _class: JClass<'local>,
        context: jni::objects::JObject<'local>,
        files_dir: jstring,
        cache_dir: jstring,
    ) {
        env_unowned
            .with_env(|env| {
                super::cache_java_vm(env);
                rustls_platform_verifier::android::init_with_env(env, context)?;
                let dir_jstr = unsafe { jni::objects::JString::from_raw(env, files_dir) };
                let dir_str: String = dir_jstr
                    .mutf8_chars(env)
                    .map(Into::into)
                    .unwrap_or_default();
                let path = std::path::PathBuf::from(&dir_str);

                let cache_jstr = unsafe { jni::objects::JString::from_raw(env, cache_dir) };
                let cache_str: String = cache_jstr
                    .mutf8_chars(env)
                    .map(Into::into)
                    .unwrap_or_default();
                let cache_path = std::path::PathBuf::from(&cache_str);
                let conf_path = path.join("rclone.conf");
                let _ = std::fs::create_dir_all(&cache_path);

                if let Err(error) = rclone_ffi::configure_default_paths(&conf_path, &cache_path) {
                    log::error!("SAF librclone initialization failed: {error}");
                }

                Ok::<(), jni::errors::Error>(())
            })
            .resolve::<jni::errors::ThrowRuntimeExAndDefault>();
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn Java_com_rclone_manager_RcloneSafBridge_nativeRpc<'local>(
        mut env_unowned: EnvUnowned<'local>,
        _class: JClass<'local>,
        endpoint: jstring,
        json_payload: jstring,
    ) -> jstring {
        let mut raw_res: jstring = std::ptr::null_mut();
        let _ = env_unowned.with_env(|env| {
            super::cache_java_vm(env);
            let endpoint_jstr = unsafe { jni::objects::JString::from_raw(env, endpoint) };
            let endpoint_str: String = endpoint_jstr
                .mutf8_chars(env)
                .map(Into::into)
                .unwrap_or_default();

            let payload_jstr = unsafe { jni::objects::JString::from_raw(env, json_payload) };
            let payload_str: String = payload_jstr
                .mutf8_chars(env)
                .map(Into::into)
                .unwrap_or_default();

            let res_json = match rclone_ffi::rpc_raw(&endpoint_str, &payload_str) {
                Ok(val) => val,
                Err(e) => serde_json::json!({ "error": e.to_string() }).to_string(),
            };

            if let Ok(jstr) = env.new_string(res_json) {
                raw_res = jstr.into_raw();
            }
            Ok::<(), jni::errors::Error>(())
        });
        raw_res
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn Java_com_rclone_manager_RcloneSafBridge_nativeOnMeteredChanged<
        'local,
    >(
        _env: EnvUnowned<'local>,
        _class: JClass<'local>,
        is_metered: jni::sys::jboolean,
    ) {
        crate::utils::io::network::on_metered_changed(is_metered);
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn Java_com_rclone_manager_RcloneSafBridge_nativeVfsRead<'local>(
        mut env_unowned: EnvUnowned<'local>,
        _class: JClass<'local>,
        handle_id: jni::sys::jlong,
        offset: jni::sys::jlong,
        count: jni::sys::jint,
        byte_array: jni::sys::jbyteArray,
    ) -> jni::sys::jint {
        let mut bytes_read: jni::sys::jint = -1;
        let _ = env_unowned.with_env(|env| {
            if byte_array.is_null() || count <= 0 {
                return Ok::<(), jni::errors::Error>(());
            }

            let raw_env = env.get_raw();
            let get_array_len = unsafe { (**raw_env).v1_1.GetArrayLength };
            let array_len = unsafe { get_array_len(raw_env, byte_array) };
            if (count as usize) > (array_len as usize) {
                return Ok::<(), jni::errors::Error>(());
            }

            // The read can block on the network, so it must not run inside a critical array
            // section, which keeps the runtime from moving objects until it is released.
            let mut buffer = vec![0u8; count as usize];
            bytes_read =
                unsafe { super::RcloneVfsRead(handle_id, offset, count, buffer.as_mut_ptr()) };
            if bytes_read > 0 {
                let set_region = unsafe { (**raw_env).v1_1.SetByteArrayRegion };
                unsafe {
                    set_region(
                        raw_env,
                        byte_array,
                        0,
                        bytes_read.min(count),
                        buffer.as_ptr().cast(),
                    );
                }
            }

            Ok::<(), jni::errors::Error>(())
        });
        bytes_read
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn Java_com_rclone_manager_RcloneSafBridge_nativeVfsWrite<'local>(
        mut env_unowned: EnvUnowned<'local>,
        _class: JClass<'local>,
        handle_id: jni::sys::jlong,
        offset: jni::sys::jlong,
        count: jni::sys::jint,
        byte_array: jni::sys::jbyteArray,
    ) -> jni::sys::jint {
        let mut bytes_written: jni::sys::jint = -1;
        let _ = env_unowned.with_env(|env| {
            if byte_array.is_null() || count <= 0 {
                return Ok::<(), jni::errors::Error>(());
            }

            let raw_env = env.get_raw();
            let get_array_len = unsafe { (**raw_env).v1_1.GetArrayLength };
            let array_len = unsafe { get_array_len(raw_env, byte_array) };
            if (count as usize) > (array_len as usize) {
                return Ok::<(), jni::errors::Error>(());
            }

            // Copy out first: the write can block on the network, so it must not run inside a
            // critical array section.
            let mut buffer = vec![0u8; count as usize];
            let get_region = unsafe { (**raw_env).v1_1.GetByteArrayRegion };
            unsafe {
                get_region(raw_env, byte_array, 0, count, buffer.as_mut_ptr().cast());
            }
            bytes_written =
                unsafe { super::RcloneVfsWrite(handle_id, offset, count, buffer.as_ptr()) };

            Ok::<(), jni::errors::Error>(())
        });
        bytes_written
    }
}

unsafe extern "C" {
    fn RcloneVfsRead(handle_id: i64, offset: i64, count: i32, out_ptr: *mut u8) -> i32;
    fn RcloneVfsWrite(handle_id: i64, offset: i64, count: i32, in_ptr: *const u8) -> i32;
}
