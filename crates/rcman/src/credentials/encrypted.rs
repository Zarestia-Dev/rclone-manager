//! Encrypted file backend for credential storage
//!
//! Uses AES-256-GCM for encryption, suitable for CI/Docker environments
//! where OS keychain is not available.

use super::CredentialBackend;
use crate::error::{Error, Result};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use log::debug;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

/// Encrypted credential entry
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedEntry {
    /// Base64-encoded nonce
    nonce: String,
    /// Base64-encoded ciphertext
    ciphertext: String,
}

/// Encrypted file storage format
#[derive(Debug, Default, Serialize, Deserialize)]
struct EncryptedStore {
    version: u32,
    /// Base64-encoded salt for Argon2id key derivation (stored plaintext, safe)
    #[serde(default)]
    salt: Option<String>,
    entries: HashMap<String, EncryptedEntry>,
}

/// Encrypted file backend using AES-256-GCM
pub struct EncryptedFileBackend {
    path: PathBuf,
    cipher: Aes256Gcm,
    /// Salt used for key derivation (stored in file for decryption on restart)
    salt: [u8; 16],
    cache: RwLock<HashMap<String, String>>,
}

impl EncryptedFileBackend {
    /// Create a new encrypted file backend
    ///
    /// # Arguments
    /// * `path` - Path to the encrypted credentials file
    /// * `key` - 32-byte encryption key (derived from password + salt)
    /// * `salt` - 16-byte salt used for key derivation (will be stored in file)
    ///
    /// # Errors
    /// Returns an error if the key length is invalid.
    pub fn new(path: PathBuf, key: &[u8; 32], salt: [u8; 16]) -> Result<Self> {
        Ok(Self {
            path,
            cipher: Aes256Gcm::new_from_slice(key)
                .map_err(|_| Error::Credential("Invalid key length".into()))?,
            salt,
            cache: RwLock::new(HashMap::new()),
        })
    }

    /// Create an encrypted file backend from a password
    ///
    /// This is the recommended constructor. It handles salt automatically:
    /// - If file exists, reads salt from it
    /// - If file is new, generates a random salt
    ///
    /// # Example
    /// ```rust,ignore
    /// let backend = EncryptedFileBackend::with_password(path, "user_password")?;
    /// ```
    pub fn with_password(path: PathBuf, password: &str) -> Result<Self> {
        let salt = Self::read_salt(&path)?.unwrap_or_else(Self::generate_salt);
        let key = Self::derive_key(password, &salt)?;
        Self::new(path, &key, salt)
    }

    /// Read the salt from an existing encrypted file (without needing the key)
    ///
    /// Returns `None` if the file doesn't exist or has no salt (v1 format).
    /// Call this FIRST, then derive the key, then create the backend.
    pub fn read_salt(path: &PathBuf) -> Result<Option<[u8; 16]>> {
        use base64::Engine;

        if !path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(path).map_err(|e| Error::FileRead {
            path: path.display().to_string(),
            source: e,
        })?;

        let store: EncryptedStore = serde_json::from_str(&content)
            .map_err(|e| Error::Credential(format!("Failed to parse encrypted store: {}", e)))?;

        if let Some(salt_b64) = store.salt {
            let salt_vec = base64::engine::general_purpose::STANDARD
                .decode(&salt_b64)
                .map_err(|e| Error::Credential(format!("Invalid salt encoding: {}", e)))?;

            if salt_vec.len() != 16 {
                return Err(Error::Credential(format!(
                    "Invalid salt length: expected 16, got {}",
                    salt_vec.len()
                )));
            }

            let mut salt = [0u8; 16];
            salt.copy_from_slice(&salt_vec);
            Ok(Some(salt))
        } else {
            Ok(None)
        }
    }

    /// Generate a random 32-byte encryption key
    pub fn generate_key() -> [u8; 32] {
        rand::rng().random()
    }

    /// Generate a random 16-byte salt for Argon2
    pub fn generate_salt() -> [u8; 16] {
        rand::rng().random()
    }

    /// Derive a key from a password using Argon2id
    ///
    /// Uses Argon2id (memory-hard) for state-of-the-art protection against GPU attacks.
    ///
    /// # Arguments
    /// * `password` - The user password
    /// * `salt` - A 16-byte random salt (use `generate_salt()` or `read_salt()`)
    ///
    /// # Errors
    /// Returns an error if salt encoding or hashing fails.
    pub fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32]> {
        use argon2::{
            password_hash::{PasswordHasher, SaltString},
            Argon2,
        };

        // Convert salt to B64 for Argon2
        let salt_string = SaltString::encode_b64(salt)
            .map_err(|e| Error::Credential(format!("Invalid salt bytes: {}", e)))?;

        // Hash password
        let argon2 = Argon2::default();
        let password_hash = argon2
            .hash_password(password.as_bytes(), &salt_string)
            .map_err(|e| Error::Credential(format!("Argon2 hashing failed: {}", e)))?;

        let output = password_hash
            .hash
            .ok_or_else(|| Error::Credential("Hash output missing".into()))?;
        let bytes = output.as_bytes();

        if bytes.len() < 32 {
            return Err(Error::Credential(format!(
                "Argon2 output too short: {}",
                bytes.len()
            )));
        }

        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes[..32]);
        Ok(key)
    }

    fn load_store(&self) -> Result<EncryptedStore> {
        if !self.path.exists() {
            return Ok(EncryptedStore::default());
        }

        let content = fs::read_to_string(&self.path).map_err(|e| Error::FileRead {
            path: self.path.display().to_string(),
            source: e,
        })?;

        serde_json::from_str(&content)
            .map_err(|e| Error::Credential(format!("Failed to parse encrypted store: {}", e)))
    }

    fn save_store(&self, store: &mut EncryptedStore) -> Result<()> {
        use base64::Engine;

        // Always ensure salt is saved (v1 Argon2)
        store.version = 1;
        store.salt = Some(base64::engine::general_purpose::STANDARD.encode(self.salt));

        let content = serde_json::to_string_pretty(store).map_err(|e| {
            Error::Credential(format!("Failed to serialize encrypted store: {}", e))
        })?;

        // Ensure parent directory exists
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| Error::DirectoryCreate {
                path: parent.display().to_string(),
                source: e,
            })?;
        }

        fs::write(&self.path, content).map_err(|e| Error::FileWrite {
            path: self.path.display().to_string(),
            source: e,
        })?;

        Ok(())
    }

    fn encrypt(&self, plaintext: &str) -> Result<EncryptedEntry> {
        let nonce_bytes: [u8; 12] = rand::rng().random();
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| Error::Credential(format!("Encryption failed: {}", e)))?;

        Ok(EncryptedEntry {
            nonce: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, nonce_bytes),
            ciphertext: base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                &ciphertext,
            ),
        })
    }

    fn decrypt(&self, entry: &EncryptedEntry) -> Result<String> {
        use base64::Engine;

        let nonce_bytes = base64::engine::general_purpose::STANDARD
            .decode(&entry.nonce)
            .map_err(|e| Error::Credential(format!("Invalid nonce: {}", e)))?;

        let ciphertext = base64::engine::general_purpose::STANDARD
            .decode(&entry.ciphertext)
            .map_err(|e| Error::Credential(format!("Invalid ciphertext: {}", e)))?;

        let nonce = Nonce::from_slice(&nonce_bytes);

        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|_| Error::Credential("Decryption failed (wrong key?)".into()))?;

        String::from_utf8(plaintext).map_err(|e| Error::Credential(format!("Invalid UTF-8: {}", e)))
    }
}

impl CredentialBackend for EncryptedFileBackend {
    fn store(&self, key: &str, value: &str) -> Result<()> {
        let mut store = self.load_store()?;
        let encrypted = self.encrypt(value)?;

        store.entries.insert(key.to_string(), encrypted);

        self.save_store(&mut store)?;

        // Update cache
        if let Ok(mut cache) = self.cache.write() {
            cache.insert(key.to_string(), value.to_string());
        }

        debug!("✅ Credential stored in encrypted file: {}", key);
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<String>> {
        // Check cache first
        if let Ok(cache) = self.cache.read() {
            if let Some(value) = cache.get(key) {
                return Ok(Some(value.clone()));
            }
        }

        let store = self.load_store()?;

        if let Some(entry) = store.entries.get(key) {
            let value = self.decrypt(entry)?;

            // Update cache
            if let Ok(mut cache) = self.cache.write() {
                cache.insert(key.to_string(), value.clone());
            }

            debug!("✅ Credential retrieved from encrypted file: {}", key);
            Ok(Some(value))
        } else {
            Ok(None)
        }
    }

    fn remove(&self, key: &str) -> Result<()> {
        let mut store = self.load_store()?;
        store.entries.remove(key);
        self.save_store(&mut store)?;

        // Update cache
        if let Ok(mut cache) = self.cache.write() {
            cache.remove(key);
        }

        debug!("✅ Credential removed from encrypted file: {}", key);
        Ok(())
    }

    fn list_keys(&self) -> Result<Vec<String>> {
        let store = self.load_store()?;
        Ok(store.entries.keys().cloned().collect())
    }

    fn backend_name(&self) -> &'static str {
        "encrypted_file"
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_encrypted_store_and_get() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("credentials.enc.json");
        let salt = EncryptedFileBackend::generate_salt();
        let key = EncryptedFileBackend::generate_key();

        let backend = EncryptedFileBackend::new(path.clone(), &key, salt).unwrap();

        backend.store("api_key", "secret123").unwrap();
        backend.store("password", "hunter2").unwrap();

        // Create new instance to test persistence (must use same key and salt)
        let backend2 = EncryptedFileBackend::new(path, &key, salt).unwrap();

        assert_eq!(
            backend2.get("api_key").unwrap(),
            Some("secret123".to_string())
        );
        assert_eq!(
            backend2.get("password").unwrap(),
            Some("hunter2".to_string())
        );
    }

    #[test]
    fn test_encrypted_wrong_key() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("credentials.enc.json");
        let salt = EncryptedFileBackend::generate_salt();
        let key1 = EncryptedFileBackend::generate_key();
        let key2 = EncryptedFileBackend::generate_key();

        let backend1 = EncryptedFileBackend::new(path.clone(), &key1, salt).unwrap();
        backend1.store("secret", "value").unwrap();

        // Try to read with different key (same salt, simulating wrong password)
        let backend2 = EncryptedFileBackend::new(path, &key2, salt).unwrap();
        let result = backend2.get("secret");

        assert!(result.is_err());
    }

    #[test]
    fn test_with_password() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("credentials.enc.json");

        // Create with password (generates salt automatically)
        let backend = EncryptedFileBackend::with_password(path.clone(), "test_password").unwrap();
        backend.store("api_key", "secret123").unwrap();

        // Reopen with same password - should read salt from file
        let backend2 = EncryptedFileBackend::with_password(path.clone(), "test_password").unwrap();
        assert_eq!(
            backend2.get("api_key").unwrap(),
            Some("secret123".to_string())
        );

        // Wrong password should fail to decrypt
        let backend3 = EncryptedFileBackend::with_password(path, "wrong_password").unwrap();
        assert!(backend3.get("api_key").is_err());
    }

    #[test]
    fn test_derive_key() {
        let salt = EncryptedFileBackend::generate_salt();

        // Same password + same salt = same key
        let key1 = EncryptedFileBackend::derive_key("password123", &salt).unwrap();
        let key2 = EncryptedFileBackend::derive_key("password123", &salt).unwrap();
        assert_eq!(key1, key2);

        // Different password = different key
        let key3 = EncryptedFileBackend::derive_key("different", &salt).unwrap();
        assert_ne!(key1, key3);

        // Different salt = different key (even with same password)
        let salt2 = EncryptedFileBackend::generate_salt();
        let key4 = EncryptedFileBackend::derive_key("password123", &salt2).unwrap();
        assert_ne!(key1, key4);
    }
}
