static JAVA_VM: std::sync::OnceLock<jni::JavaVM> = std::sync::OnceLock::new();
static BRIDGE_CLASS: std::sync::OnceLock<jni::objects::Global<jni::objects::JClass>> =
    std::sync::OnceLock::new();

fn cache_java_vm(env: &mut jni::Env) {
    if JAVA_VM.get().is_none() {
        if let Ok(vm) = env.get_java_vm() {
            let _ = JAVA_VM.set(vm);
        }
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

pub fn notify_roots_changed() {
    let Some(vm) = JAVA_VM.get() else { return };
    let Some(g_cls) = BRIDGE_CLASS.get() else {
        return;
    };
    let _ = vm.attach_current_thread(|env| {
        use jni::{jni_sig, jni_str};
        let cls: &jni::objects::JClass = g_cls.as_ref();
        let _ = env.call_static_method(cls, jni_str!("notifyRootsChanged"), jni_sig!("()V"), &[]);
        Ok::<(), jni::errors::Error>(())
    });
}

pub fn update_mounted_remotes(remotes: &[crate::utils::types::remotes::MountedRemote]) {
    let Some(vm) = JAVA_VM.get() else { return };
    let Some(g_cls) = BRIDGE_CLASS.get() else {
        return;
    };
    let json_str = serde_json::to_string(remotes).unwrap_or_else(|_| "[]".to_string());
    let _ = vm.attach_current_thread(|env| {
        use jni::{jni_sig, jni_str};
        let cls: &jni::objects::JClass = g_cls.as_ref();
        if let Ok(jstr) = env.new_string(&json_str) {
            let _ = env.call_static_method(
                cls,
                jni_str!("updateMountedRemotes"),
                jni_sig!("(Ljava/lang/String;)V"),
                &[(&jstr).into()],
            );
        }
        Ok::<(), jni::errors::Error>(())
    });
}

pub fn open_saf_remote(remote_name: &str) -> bool {
    let Some(vm) = JAVA_VM.get() else {
        return false;
    };
    let Some(g_cls) = BRIDGE_CLASS.get() else {
        return false;
    };
    let mut success = false;
    let _ = vm.attach_current_thread(|env| {
        use jni::{jni_sig, jni_str};
        let cls: &jni::objects::JClass = g_cls.as_ref();
        if let Ok(jstr) = env.new_string(remote_name) {
            if let Ok(res) = env.call_static_method(
                cls,
                jni_str!("openSafRemote"),
                jni_sig!("(Ljava/lang/String;)Z"),
                &[(&jstr).into()],
            ) {
                if let Ok(val) = res.z() {
                    success = val;
                }
            }
        }
        Ok::<(), jni::errors::Error>(())
    });
    success
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
        files_dir: jstring,
    ) {
        let _ = env_unowned.with_env(|env| {
            super::cache_java_vm(env);
            let dir_jstr = unsafe { jni::objects::JString::from_raw(env, files_dir) };
            let dir_str = dir_jstr.to_string();
            let path = std::path::PathBuf::from(&dir_str);
            let cache_path = path.join("cache");
            let _ = std::fs::create_dir_all(&cache_path);

            unsafe {
                std::env::set_var("HOME", &path);
                std::env::set_var("XDG_CONFIG_HOME", &path);
                std::env::set_var("XDG_CACHE_HOME", &cache_path);
                std::env::set_var("TMPDIR", &cache_path);
                std::env::set_var("TMP", &cache_path);
            }

            rclone_ffi::initialize();

            let conf_path = path.join("rclone.conf");
            let _ = rclone_ffi::rpc(&serde_json::json!({
                "_path": "config/setpath",
                "path": conf_path.to_string_lossy().to_string(),
            }));
            let _ = rclone_ffi::rpc(&serde_json::json!({
                "_path": "config/setcachedir",
                "path": cache_path.to_string_lossy().to_string(),
            }));

            Ok::<(), jni::errors::Error>(())
        });
    }

    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn Java_com_rclone_manager_RcloneSafBridge_nativeRpc<'local>(
        mut env_unowned: EnvUnowned<'local>,
        _class: JClass<'local>,
        json_payload: jstring,
    ) -> jstring {
        let mut raw_res: jstring = std::ptr::null_mut();
        let _ = env_unowned.with_env(|env| {
            super::cache_java_vm(env);
            let payload_jstr = unsafe { jni::objects::JString::from_raw(env, json_payload) };
            let payload_str = payload_jstr.to_string();

            let req: serde_json::Value =
                serde_json::from_str(&payload_str).unwrap_or(serde_json::json!({}));
            let res = rclone_ffi::rpc(&req);

            let res_json = match res {
                Ok(val) => val.to_string(),
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

            let get_crit = unsafe { (**raw_env).v1_2.GetPrimitiveArrayCritical };
            let rel_crit = unsafe { (**raw_env).v1_2.ReleasePrimitiveArrayCritical };

            let mut is_copy: jni::sys::jboolean = false;
            let ptr = unsafe { get_crit(raw_env, byte_array, &mut is_copy) };

            if !ptr.is_null() {
                bytes_read =
                    unsafe { super::RcloneVfsRead(handle_id, offset, count, ptr as *mut u8) };
            }
            unsafe {
                rel_crit(raw_env, byte_array, ptr, 0);
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

            let get_crit = unsafe { (**raw_env).v1_2.GetPrimitiveArrayCritical };
            let rel_crit = unsafe { (**raw_env).v1_2.ReleasePrimitiveArrayCritical };

            let mut is_copy: jni::sys::jboolean = false;
            let ptr = unsafe { get_crit(raw_env, byte_array, &mut is_copy) };

            if !ptr.is_null() {
                bytes_written =
                    unsafe { super::RcloneVfsWrite(handle_id, offset, count, ptr as *const u8) };

                unsafe {
                    rel_crit(raw_env, byte_array, ptr, jni::sys::JNI_ABORT);
                }
            }

            Ok::<(), jni::errors::Error>(())
        });
        bytes_written
    }
}

unsafe extern "C" {
    fn RcloneVfsRead(handle_id: i64, offset: i64, count: i32, out_ptr: *mut u8) -> i32;
    fn RcloneVfsWrite(handle_id: i64, offset: i64, count: i32, in_ptr: *const u8) -> i32;
}
