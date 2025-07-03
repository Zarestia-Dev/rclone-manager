use std::sync::Mutex;
use once_cell::sync::Lazy;

use crate::utils::types::EngineState;

pub static ENGINE_STATE: Lazy<EngineState> = Lazy::new(|| EngineState {
    api_url: Mutex::new(String::new()),
    api_port: Mutex::new(5572),
    oauth_url: Mutex::new(String::new()),
    oauth_port: Mutex::new(5580),
});

impl EngineState {
    pub fn set_api(&self, url: String, port: u16) -> Result<(), String> {
        *self.api_url.lock().map_err(|e| e.to_string())? = url;
        *self.api_port.lock().map_err(|e| e.to_string())? = port;
        Ok(())
    }

    pub fn get_api(&self) -> (String, u16) {
        (
            self.api_url.lock().unwrap().clone(),
            *self.api_port.lock().unwrap(),
        )
    }

    pub fn set_oauth(&self, url: String, port: u16) -> Result<(), String> {
        *self.oauth_url.lock().map_err(|e| e.to_string())? = url;
        *self.oauth_port.lock().map_err(|e| e.to_string())? = port;
        Ok(())
    }

    pub fn get_oauth(&self) -> (String, u16) {
        (
            self.oauth_url.lock().unwrap().clone(),
            *self.oauth_port.lock().unwrap(),
        )
    }
}
