//! Transport-neutral invoke adapter for the shared command contract.
/// Internal helper macro to handle different function signatures (sync/async, with/without `AppHandle`)
macro_rules! call_internal {
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [infallible]) => {
        $path($app.clone(), $($args.$arg),*).await
    };
    // Sync + AppHandle + Infallible
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [sync, infallible]) => {
        $path($app.clone(), $($args.$arg),*)
    };
    // Sync + No AppHandle
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [sync, no_app]) => {
        $path($($args.$arg),*).map_err(command_error)?
    };
    // Sync + AppHandle (Default if sync is present)
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [sync]) => {
        $path($app.clone(), $($args.$arg),*).map_err(command_error)?
    };
    // Async + No AppHandle
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [no_app]) => {
        $path($($args.$arg),*).await.map_err(command_error)?
    };
    // Async + AppHandle (Default)
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], []) => {
        $path($app.clone(), $($args.$arg),*).await.map_err(command_error)?
    };
    // Sync + No AppHandle + Infallible (function returns T directly, not Result)
    ($path:path, $app:expr, $args:expr, [$($arg:ident),*], [sync, no_app, infallible]) => {
        $path($($args.$arg),*)
    };
}

/// Generate the shared command dispatcher.
macro_rules! command_dispatch_gen {
    ($( $(#[$meta:meta])? ($name:ident, $path:path, [$($arg:ident : $typ:ty),*] $(, [$($tag:ident),*])?) );* $(;)?) => {
        pub async fn bridge_dispatch(
            app: &crate::context::AppHandle,
            command: &str,
            payload: serde_json::Value
        ) -> Result<serde_json::Value, serde_json::Value> {
            use crate::services::settings::access;
            let public = access::allowed_when_locked(command);
            let revision = access::revision(app);
            if !public {
                access::require_session(app, revision).map_err(command_error)?;
            }
            let result = async { match command {
                $(
                    $(#[$meta])?
                    stringify!($name) => {
                        #[derive(serde::Deserialize)]
                        #[serde(rename_all = "camelCase")]
                        struct Args { $($arg: $typ),* }
                        let _args: Args = serde_json::from_value(payload).map_err(|e| serde_json::Value::String(e.to_string()))?;

                        let res = call_internal!($path, app, _args, [$($arg),*], [$($($tag),*)?]);
                        Ok(serde_json::to_value(res).map_err(|e| serde_json::Value::String(e.to_string()))?)
                    }
                )*
                _ => Err(serde_json::Value::String(format!("Command '{}' not found in bridge", command)))
            }}.await;
            // Discard data from commands that outlive their unlocked session.
            if !public && !(command == "lock_vault" && result.is_ok()) {
                access::require_session(app, revision).map_err(command_error)?;
            }
            result
        }

        pub fn is_command(command: &str) -> bool {
            match command { $( $(#[$meta])? stringify!($name) => true, )* _ => false }
        }

    };
}

// A unified dispatch function that can be used by the web server bridge.
crate::MASTER_COMMAND_LIST!(command_dispatch_gen);

fn command_error(error: impl serde::Serialize) -> serde_json::Value {
    serde_json::to_value(error).unwrap_or_else(|e| serde_json::Value::String(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::bridge_dispatch;
    use crate::context::AppHandle;
    use serde_json::json;

    #[test]
    fn domain_errors_keep_their_localization_payload() {
        let error = crate::utils::types::updater::UpdaterError::NoPendingUpdate;
        assert_eq!(
            super::command_error(error),
            serde_json::to_value(crate::localized_error!("backendErrors.updater.noPending"))
                .unwrap()
        );
        assert_eq!(super::command_error("plain error"), json!("plain error"));
    }
    #[tokio::test]
    async fn dispatches_shared_commands_without_native_state() {
        let app = AppHandle::default();
        assert_eq!(
            bridge_dispatch(&app, "is_librclone", json!({}))
                .await
                .unwrap(),
            json!(cfg!(feature = "librclone"))
        );
        assert_eq!(
            bridge_dispatch(&app, "get_build_type", json!({}))
                .await
                .unwrap(),
            json!(crate::utils::app::platform::get_build_type())
        );
        assert_eq!(
            bridge_dispatch(&app, "can_auto_install", json!({}))
                .await
                .unwrap(),
            json!(false)
        );
        let policy = bridge_dispatch(&app, "get_update_policy", json!({}))
            .await
            .unwrap();
        assert_eq!(policy["canInstall"], false);
        assert_eq!(policy["method"], "unavailable");
    }

    #[tokio::test]
    async fn pending_exit_dispatch_consumes_only_the_requesting_context() {
        use crate::services::lifecycle::exit::{
            ActiveOperationsSummary, set_pending_app_exit_summary,
        };
        let app = AppHandle::default();
        set_pending_app_exit_summary(
            &app,
            ActiveOperationsSummary {
                has_active_operations: true,
                active_jobs_count: 1,
                active_mounts_count: 0,
                active_serves_count: 0,
            },
        );
        assert_eq!(
            bridge_dispatch(&AppHandle::default(), "check_pending_app_exit", json!({}))
                .await
                .unwrap(),
            json!(null)
        );
        let summary = bridge_dispatch(&app, "check_pending_app_exit", json!({}))
            .await
            .unwrap();
        assert_eq!(summary["activeJobsCount"], 1);
        assert_eq!(
            bridge_dispatch(&app, "check_pending_app_exit", json!({}))
                .await
                .unwrap(),
            json!(null)
        );
    }

    #[tokio::test]
    async fn rejects_unknown_and_native_only_commands() {
        let app = AppHandle::default();
        for command in ["", "unknown/özel", "set_theme", "new_window"] {
            let error = bridge_dispatch(&app, command, json!({})).await.unwrap_err();
            assert!(error.as_str().unwrap().contains("not found in bridge"));
        }
    }

    #[tokio::test]
    async fn rejects_invalid_arguments_before_accessing_application_state() {
        let app = AppHandle::default();
        for payload in [json!(null), json!({}), json!({"visible": "yes"})] {
            assert!(
                bridge_dispatch(&app, "set_poller_visibility", payload)
                    .await
                    .is_err()
            );
        }
    }
}
