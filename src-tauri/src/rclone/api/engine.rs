use std::{error::Error, process::{Child, Command}, sync::{Arc, Mutex}, thread, time::Duration};

use log::{debug, error, info, warn};

use once_cell::sync::Lazy;
use std::sync::RwLock;
use reqwest::blocking::Client;

use crate::rclone::api::state::{set_rclone_api_url, set_rclone_oauth_url_port};

use super::state::get_rclone_api_url_global;


static HTTP_CLIENT: Lazy<Client> = Lazy::new(Client::new);
static LAST_KNOWN_STATE: Lazy<RwLock<bool>> = Lazy::new(|| RwLock::new(false));

pub fn is_rc_api_running() -> bool {
    let url = format!("{}/config/listremotes", get_rclone_api_url_global());

    let new_state = match HTTP_CLIENT.post(&url).send() {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    };

    let mut last_state = LAST_KNOWN_STATE.write().unwrap();
    if *last_state != new_state {
        *last_state = new_state; // Update state
        if new_state {
            info!("✅ Rclone API is back online!");
        } else {
            warn!("⚠️ Rclone API is down!");
        }
    }

    new_state
}

pub fn start_rc_api(port: u16) -> Result<Child, Box<dyn Error>> {
    info!("🚀 Starting Rclone RC API on port {}", port);

    let child = Command::new("rclone")
        .args(&[
            "rcd",
            "--rc-no-auth",
            "--rc-serve",
            &format!("--rc-addr=localhost:{}", port),
        ])
        .spawn()
        .map_err(|e| {
            error!("❌ Failed to start Rclone RC API: {}", e);
            e
        })?;

    debug!("✅ Rclone RC API started with PID: {:?}", child.id());
    Ok(child)
}

pub fn stop_rc_api(rc_process: &mut Option<Child>) {
    if let Some(mut child) = rc_process.take() {
        if let Err(e) = child.kill() {
            warn!("Failed to kill Rclone process: {}", e);
        } else {
            info!("Rclone process killed successfully.");
        }
    }
}

pub fn ensure_rc_api_running(rc_process: Arc<Mutex<Option<Child>>>, rc_port: u16, oauth_port: u16) {
    set_rclone_api_url(rc_port);
    set_rclone_oauth_url_port(oauth_port);
    info!("🔧 Ensuring Rclone RC API is running on port {}", rc_port);

    thread::spawn(move || {
        loop {
            {
                let process_guard = rc_process.lock();

                match process_guard {
                    Ok(mut process_guard) => {
                        if !is_rc_api_running() {
                            warn!("⚠️ Rclone API is not running. Attempting to restart...");

                            stop_rc_api(&mut process_guard);

                            match start_rc_api(rc_port) {
                                Ok(child) => {
                                    info!(
                                        "✅ Rclone RC API started successfully on port {}",
                                        rc_port
                                    );
                                    *process_guard = Some(child);
                                }
                                Err(e) => {
                                    error!("🚨 Failed to start Rclone RC API: {}", e);
                                }
                            }
                        } else {
                            debug!("✅ Rclone API is running on port {}", rc_port);
                        }
                    }
                    Err(_) => {
                        error!("❌ Failed to acquire lock for Rclone process.");
                    }
                }
            }
            thread::sleep(Duration::from_secs(10)); // Adjust the sleep duration as needed
        }
    });
}