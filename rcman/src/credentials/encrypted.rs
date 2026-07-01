//! Encrypted file backend for credential storage
//!
//! Uses AES-256-GCM for encryption, suitable for CI/Docker environments
//! where OS keychain is not available.

use super::CredentialBackend;
use super::types::SecretPasswordSource;
use crate::error::{Error, Result};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use log::debug;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

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
    /// Plaintext read-cache.
    ///
    /// Populated lazily on `get()` and kept in sync on `store()`/`remove()`.
    cache: RwLock<HashMap<String, String>>,
    /// Serializes all mutations to the encrypted file.
    ///
    /// BUG FIX: without this lock, two concurrent `store()` / `remove()` calls
    /// both read the file into separate in-memory copies, modify their own copy,
    /// and write back.  The second write silently drops the first writer's change.
    /// Holding this mutex across the entire read-modify-write cycle prevents the
    /// TOCTOU race.  The read cache (`self.cache`) is updated while the mutex is
    /// still held, so cache and disk are always consistent.
    write_lock: Mutex<()>,
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
    pub(crate) fn new(path: PathBuf, key: &[u8; 32], salt: [u8; 16]) -> Result<Self> {
        let backend = Self {
            path,
            cipher: Aes256Gcm::new_from_slice(key)
                .map_err(|_| Error::Credential("Invalid encryption key length".into()))?,
            salt,
            cache: RwLock::new(HashMap::new()),
            write_lock: Mutex::new(()),
        };
        backend.warm_cache()?;
        Ok(backend)
    }

    /// Warm the cache by decrypting all stored credentials.
    ///
    /// # Errors
    ///
    /// Returns an error if the store cannot be loaded or if decryption fails.
    pub fn warm_cache(&self) -> Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| Error::Credential("Encrypted file write lock poisoned".into()))?;

        let store = self.load_store()?;
        let mut cache = self.cache.write().map_err(|_| Error::LockPoisoned)?;

        for (key, entry) in &store.entries {
            let value = self.decrypt(entry)?;
            cache.insert(key.clone(), value);
        }

        Ok(())
    }

    /// Create an encrypted file backend from a password source
    ///
    /// This handles salt reading/generation and key derivation automatically.
    ///
    /// # Errors
    ///
    /// Returns an error if the password source fails to resolve (e.g., missing environment variable)
    /// or if the encrypted file exists but is corrupted.
    pub fn with_source(path: PathBuf, source: &SecretPasswordSource) -> Result<Self> {
        Self::with_password(path, &source.resolve()?)
    }

    /// Create an encrypted file backend from a password
    ///
    /// This is the recommended constructor. It handles salt automatically:
    /// - If file exists, reads salt from it
    /// - If file is new, generates a random salt
    ///
    /// # Example
    /// ```rust,no_run
    /// use std::path::PathBuf;
    /// # fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// use rcman::EncryptedFileBackend;
    ///
    /// let path = PathBuf::from("/tmp/credentials.enc.json");
    /// let backend = EncryptedFileBackend::with_password(path, "user_password")?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    ///
    /// Returns an error if the file cannot be read or parsed.
    pub fn with_password(path: PathBuf, password: &str) -> Result<Self> {
        let salt = Self::read_salt(&path)?.unwrap_or_else(Self::generate_salt);
        let key = Self::derive_key(password, &salt)?;
        Self::new(path, &key, salt)
    }

    /// Read the salt from an existing encrypted file (without needing the key)
    ///
    /// Returns `None` if the file doesn't exist or has no salt (v1 format).
    /// Call this FIRST, then derive the key, then create the backend.
    ///
    /// # Errors
    ///
    /// Returns an error if the file cannot be read or parsed.
    pub fn read_salt(path: &Path) -> Result<Option<[u8; 16]>> {
        if !path.exists() {
            return Ok(None);
        }

        let content = fs::read_to_string(path).map_err(|e| Error::FileRead {
            path: path.to_path_buf(),
            source: e,
        })?;

        let store: EncryptedStore = serde_json::from_str(&content)
            .map_err(|e| Error::Credential(format!("Failed to parse encrypted store: {e}")))?;

        let Some(salt_b64) = store.salt else {
            return Ok(None);
        };

        let salt_vec = BASE64
            .decode(&salt_b64)
            .map_err(|e| Error::Credential(format!("Invalid salt encoding: {e}")))?;

        if salt_vec.len() != 16 {
            return Err(Error::Credential(format!(
                "Invalid salt length: expected 16, got {}",
                salt_vec.len()
            )));
        }

        let mut salt = [0u8; 16];
        salt.copy_from_slice(&salt_vec);
        Ok(Some(salt))
    }

    /// Generate a random 32-byte encryption key
    #[must_use]
    pub fn generate_key() -> [u8; 32] {
        rand::rng().random()
    }

    /// Generate a random 16-byte salt for Argon2
    #[must_use]
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
            Argon2,
            password_hash::{PasswordHasher, SaltString},
        };

        let salt_string = SaltString::encode_b64(salt)
            .map_err(|e| Error::Credential(format!("Invalid salt bytes: {e}")))?;

        let password_hash = Argon2::default()
            .hash_password(password.as_bytes(), &salt_string)
            .map_err(|e| Error::Credential(format!("Argon2 hashing failed: {e}")))?;

        let output = password_hash
            .hash
            .ok_or_else(|| Error::Credential("Argon2 hash output missing".into()))?;

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
            path: self.path.clone(),
            source: e,
        })?;

        serde_json::from_str(&content)
            .map_err(|e| Error::Credential(format!("Failed to parse encrypted store: {e}")))
    }

    /// Serialize and atomically write the store to disk.
    ///
    /// Always writes version=1 and the backend's own salt. Entries are taken by value
    /// to avoid an extra clone when the caller is done with them.
    fn save_store(&self, entries: HashMap<String, EncryptedEntry>) -> Result<()> {
        let store = EncryptedStore {
            version: 1,
            salt: Some(BASE64.encode(self.salt)),
            entries,
        };

        let content = serde_json::to_string_pretty(&store)
            .map_err(|e| Error::Credential(format!("Failed to serialize encrypted store: {e}")))?;

        // Ensure parent directory exists
        if let Some(parent) = self.path.parent() {
            crate::utils::security::ensure_secure_dir(parent)?;
        }

        // Atomic write: write to a temp file, then rename
        let mut temp_path = self.path.clone();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let file_name = self.path.file_name().unwrap_or_default().to_string_lossy();
        temp_path.set_file_name(format!("{file_name}.{now}.tmp"));

        // Scope the temp file handle so it's dropped (closed) before we
        // try to rename.  On Windows, renaming an open file fails with
        // `Error::SharingViolation`; on Unix it works but the close
        // happens at scope-end anyway, so scoping is correct on both.
        {
            let mut temp_file = fs::File::create(&temp_path).map_err(|e| Error::FileWrite {
                path: temp_path.clone(),
                source: e,
            })?;

            temp_file
                .write_all(content.as_bytes())
                .map_err(|e| Error::FileWrite {
                    path: temp_path.clone(),
                    source: e,
                })?;

            temp_file.sync_all().map_err(|e| Error::FileWrite {
                path: temp_path.clone(),
                source: e,
            })?;
            // temp_file is dropped here → file is closed.
        }

        crate::utils::security::set_secure_file_permissions(&temp_path)?;

        // Attempt the rename.  On failure, clean up the temp file so
        // we don't leak it.  The cleanup is best-effort.
        if let Err(e) = fs::rename(&temp_path, &self.path) {
            if let Err(cleanup_err) = fs::remove_file(&temp_path) {
                log::warn!(
                    "save_store: failed to clean up temp file {} after rename failure: {cleanup_err}",
                    temp_path.display()
                );
            }
            return Err(Error::FileWrite {
                path: self.path.clone(),
                source: e,
            });
        }

        Ok(())
    }

    fn encrypt(&self, plaintext: &str) -> Result<EncryptedEntry> {
        let nonce_bytes: [u8; 12] = rand::rng().random();
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| Error::Credential(format!("Encryption failed: {e}")))?;

        Ok(EncryptedEntry {
            nonce: BASE64.encode(nonce_bytes),
            ciphertext: BASE64.encode(&ciphertext),
        })
    }

    fn decrypt(&self, entry: &EncryptedEntry) -> Result<String> {
        let nonce_bytes = BASE64
            .decode(&entry.nonce)
            .map_err(|e| Error::Credential(format!("Invalid nonce encoding: {e}")))?;

        let ciphertext = BASE64
            .decode(&entry.ciphertext)
            .map_err(|e| Error::Credential(format!("Invalid ciphertext encoding: {e}")))?;

        let nonce = Nonce::from_slice(&nonce_bytes);

        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|_| Error::Credential("Decryption failed (wrong key?)".into()))?;

        String::from_utf8(plaintext)
            .map_err(|e| Error::Credential(format!("Decrypted data is not valid UTF-8: {e}")))
    }
}

impl CredentialBackend for EncryptedFileBackend {
    fn store(&self, key: &str, value: &str) -> Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| Error::Credential("Encrypted file write lock poisoned".into()))?;

        let mut store = self.load_store()?;
        let encrypted = self.encrypt(value)?;
        store.entries.insert(key.to_string(), encrypted);
        self.save_store(store.entries)?;

        self.cache
            .write()
            .map_err(|_| Error::LockPoisoned)?
            .insert(key.to_string(), value.to_string());

        debug!("Credential stored in encrypted file: {key}");
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<String>> {
        let cache = self.cache.read().map_err(|_| Error::LockPoisoned)?;
        Ok(cache.get(key).cloned())
    }

    fn remove(&self, key: &str) -> Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| Error::Credential("Encrypted file write lock poisoned".into()))?;

        let mut store = self.load_store()?;
        store.entries.remove(key);
        self.save_store(store.entries)?;

        self.cache
            .write()
            .map_err(|_| Error::LockPoisoned)?
            .remove(key);

        debug!("Credential removed from encrypted file: {key}");
        Ok(())
    }

    fn list_keys(&self) -> Result<Vec<String>> {
        let cache = self.cache.read().map_err(|_| Error::LockPoisoned)?;
        Ok(cache.keys().cloned().collect())
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
        let backend2 = EncryptedFileBackend::new(path, &key2, salt);
        assert!(backend2.is_err());
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

        // Wrong password should fail to decrypt during initialization
        let backend3 = EncryptedFileBackend::with_password(path, "wrong_password");
        assert!(backend3.is_err());
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

    /// Regression test for the concurrent write TOCTOU bug.
    /// Two threads writing different keys must both survive.
    #[test]
    fn test_concurrent_store_no_lost_writes() {
        use std::sync::Arc;
        use std::thread;

        let temp = tempdir().unwrap();
        let path = temp.path().join("credentials.enc.json");
        let backend = Arc::new(EncryptedFileBackend::with_password(path, "password").unwrap());

        let b1 = Arc::clone(&backend);
        let b2 = Arc::clone(&backend);

        let t1 = thread::spawn(move || b1.store("key_a", "value_a").unwrap());
        let t2 = thread::spawn(move || b2.store("key_b", "value_b").unwrap());

        t1.join().unwrap();
        t2.join().unwrap();

        assert_eq!(backend.get("key_a").unwrap(), Some("value_a".to_string()));
        assert_eq!(backend.get("key_b").unwrap(), Some("value_b".to_string()));
    }
}
