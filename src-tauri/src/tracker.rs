use std::thread;
use std::time::Duration;
use crate::api::list_mounts;

pub fn start_mount_tracker() {
    thread::spawn(|| {
        loop {
            match tokio::runtime::Runtime::new().unwrap().block_on(list_mounts()) {
                Ok(mounts) => println!("Active Mounts: {:?}", mounts),
                Err(e) => eprintln!("Error tracking mounts: {}", e),
            }
            
            thread::sleep(Duration::from_secs(10));
        }
    });
}
