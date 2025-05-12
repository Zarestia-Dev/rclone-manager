use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use tauri::command;

#[derive(Debug, Serialize, Deserialize)]
pub struct CheckResult {
    pub successful: Vec<String>,
    pub failed: HashMap<String, String>,
    pub retries_used: HashMap<String, usize>,
}

#[command]
pub async fn check_links(
    links: String,
    max_retries: usize,
    retry_delay_secs: u64,
) -> Result<CheckResult, String> {
    let checker = LinkChecker::new(max_retries, retry_delay_secs);
    checker.check_links(&links).await.map_err(|e| e.to_string())
}

struct LinkChecker {
    client: reqwest::Client,
    max_retries: usize,
    retry_delay: std::time::Duration,
}

impl LinkChecker {
    fn new(max_retries: usize, retry_delay_secs: u64) -> Self {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("Failed to create HTTP client");
            
        Self {
            client,
            max_retries,
            retry_delay: std::time::Duration::from_secs(retry_delay_secs),
        }
    }
    
    async fn check_links(&self, links: &str) -> Result<CheckResult, Box<dyn std::error::Error>> {
        let links_vec: Vec<String> = links.split(';')
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
            
        let successful = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let failed = std::sync::Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let retries_used = std::sync::Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        
        let mut handles = vec![];
        
        for link in links_vec {
            let checker = self.client.clone();
            let max_retries = self.max_retries;
            let retry_delay = self.retry_delay;
            let successful = successful.clone();
            let failed = failed.clone();
            let retries_used = retries_used.clone();
            
            handles.push(tokio::spawn(async move {
                let mut last_error = None;
                let mut retries = 0;
                
                while retries <= max_retries {
                    match checker.get(&link).send().await {
                        Ok(response) => {
                            if response.status().is_success() {
                                successful.lock().await.push(link.clone());
                                retries_used.lock().await.insert(link.clone(), retries);
                                return;
                            } else {
                                last_error = Some(format!("HTTP status: {}", response.status()));
                            }
                        }
                        Err(e) => {
                            last_error = Some(e.to_string());
                        }
                    }
                    
                    if retries < max_retries {
                        tokio::time::sleep(retry_delay).await;
                    }
                    retries += 1;
                }
                
                failed.lock().await.insert(link.clone(), last_error.unwrap_or_else(|| "Unknown error".to_string()));
                retries_used.lock().await.insert(link.clone(), retries - 1);
            }));
        }
        
        // Wait for all tasks to complete
        for handle in handles {
            let _ = handle.await;
        }
        
        let successful = successful.lock().await.clone();
        let failed = failed.lock().await.clone();
        let retries_used = retries_used.lock().await.clone();
        
        Ok(CheckResult {
            successful,
            failed,
            retries_used,
        })
    }
}