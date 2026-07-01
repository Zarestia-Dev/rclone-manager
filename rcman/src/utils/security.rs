use crate::error::{Error, Result};
use std::path::Path;

/// Ensure the directory exists and has secure permissions for the current user only.
///
/// On Unix, the directory is created with mode `0700` (owner rwx only).
/// On Windows, ACLs are set to grant access only to the current user.
///
/// # Errors
///
/// Returns `Error::DirectoryCreate` if directory creation fails, or any error returned
/// by [`set_secure_dir_permissions`].
pub fn ensure_secure_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).map_err(|e| Error::DirectoryCreate {
        path: path.to_path_buf(),
        source: e,
    })?;
    set_secure_dir_permissions(path)
}

// =============================================================================
// Unix
// =============================================================================

#[cfg(unix)]
/// Set permission bits so directories are owner read-write-execute only (mode `0700`).
///
/// # Errors
///
/// Returns `Error::FileRead` if metadata lookup fails, or `Error::FileWrite` if
/// setting permissions fails.
pub fn set_secure_dir_permissions(path: &Path) -> Result<()> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let mut perms = fs::metadata(path)
        .map_err(|e| Error::FileRead {
            path: path.to_path_buf(),
            source: e,
        })?
        .permissions();

    perms.set_mode(0o700);

    fs::set_permissions(path, perms).map_err(|e| Error::FileWrite {
        path: path.to_path_buf(),
        source: e,
    })
}

#[cfg(unix)]
/// Set permission bits so files are owner read-write only (mode `0600`).
///
/// # Errors
///
/// Returns `Error::FileRead` if metadata lookup fails, or `Error::FileWrite` if
/// setting permissions fails.
pub fn set_secure_file_permissions(path: &Path) -> Result<()> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let mut perms = fs::metadata(path)
        .map_err(|e| Error::FileRead {
            path: path.to_path_buf(),
            source: e,
        })?
        .permissions();

    perms.set_mode(0o600);

    fs::set_permissions(path, perms).map_err(|e| Error::FileWrite {
        path: path.to_path_buf(),
        source: e,
    })
}

// =============================================================================
// Non-Unix (Windows + other)
// =============================================================================

#[cfg(not(unix))]
/// Set ACL-based permissions so only the current user can access the file.
///
/// # Errors
///
/// Returns an error if the ACL update fails.
pub fn set_secure_file_permissions(path: &Path) -> Result<()> {
    set_secure_acl(path)
}

#[cfg(not(unix))]
/// Set ACL-based permissions so only the current user can access the directory.
///
/// # Errors
///
/// Returns an error if the ACL update fails.
pub fn set_secure_dir_permissions(path: &Path) -> Result<()> {
    set_secure_acl(path)
}

// =============================================================================
// Windows ACL implementation
// =============================================================================

#[cfg(windows)]
mod win32_acl {
    use super::{Error, Result};
    use std::mem::MaybeUninit;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        EXPLICIT_ACCESS_W, SE_FILE_OBJECT, SET_ACCESS, SetEntriesInAclW, SetNamedSecurityInfoW,
        TRUSTEE_IS_SID, TRUSTEE_W,
    };
    use windows::Win32::Security::{
        ACL, DACL_SECURITY_INFORMATION, GetTokenInformation, NO_INHERITANCE,
        PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows::core::PWSTR;

    /// RAII guard that closes a Win32 HANDLE on drop.
    pub(super) struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: self.0 was obtained from OpenProcessToken and is valid until this drop runs.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// RAII guard that calls `LocalFree` on a pointer allocated by a Win32 API on drop.
    pub(super) struct LocalAlloced<T>(*mut T);
    impl<T> Drop for LocalAlloced<T> {
        fn drop(&mut self) {
            // SAFETY: self.0 was allocated by SetEntriesInAclW via LocalAlloc.
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.0.cast())));
            }
        }
    }

    pub(super) fn set_secure_acl(path: &Path) -> Result<()> {
        let mut path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();

        // ── Step 1: Open the process token ───────────────────────────────────────
        let token = {
            let mut raw = HANDLE::default();
            // SAFETY: GetCurrentProcess() always returns a valid pseudo-handle that
            // doesn't need to be closed. OpenProcessToken writes a real handle into `raw`.
            unsafe {
                OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_QUERY,
                    std::ptr::addr_of_mut!(raw),
                )
                .map_err(|e| Error::Config(format!("OpenProcessToken failed: {e}")))?;
            }
            OwnedHandle(raw) // handle is now closed automatically on any early return
        };

        // ── Step 2: Query buffer size, then fill TOKEN_USER ──────────────────────
        let token_user_buf: Vec<u8> = {
            let mut needed = 0u32;
            // SAFETY: Passing a null/zero-length buffer is the standard Win32 pattern for
            // querying the required size. The call is expected to fail with
            // ERROR_INSUFFICIENT_BUFFER; we intentionally discard the error and use
            // only the `needed` value it writes.
            unsafe {
                let _ = GetTokenInformation(
                    token.0,
                    TokenUser,
                    None,
                    0,
                    std::ptr::addr_of_mut!(needed),
                );
            }

            let mut buf = vec![0u8; needed as usize];
            // SAFETY: buf has exactly `needed` bytes as reported by the size query above.
            // token.0 remains valid because `token` (OwnedHandle) has not been dropped.
            unsafe {
                GetTokenInformation(
                    token.0,
                    TokenUser,
                    Some(buf.as_mut_ptr().cast()),
                    needed,
                    std::ptr::addr_of_mut!(needed),
                )
                .map_err(|e| Error::Config(format!("GetTokenInformation failed: {e}")))?;
            }
            buf
        };
        drop(token); // handle no longer needed; OwnedHandle closes it here

        // ── Step 3: Extract the SID pointer from the buffer ──────────────────────
        // TOKEN_USER contains a PSID that points *into* the same allocation as `token_user_buf`.
        // We copy the struct into properly aligned stack memory to avoid reading from a
        // potentially mis-aligned Vec<u8>, but the PSID field still points into `token_user_buf`,
        // so that Vec must remain alive for the rest of this function.
        let user_sid = {
            let mut slot = MaybeUninit::<TOKEN_USER>::uninit();
            // SAFETY: `token_user_buf` was filled by GetTokenInformation with a valid TOKEN_USER
            // layout. copy_nonoverlapping works byte-by-byte so the source alignment doesn't matter;
            // the destination (slot) is stack-allocated and correctly aligned for TOKEN_USER.
            unsafe {
                std::ptr::copy_nonoverlapping(
                    token_user_buf.as_ptr(),
                    slot.as_mut_ptr().cast::<u8>(),
                    std::mem::size_of::<TOKEN_USER>(),
                );
                slot.assume_init().User.Sid
            }
        };

        // ── Step 4: Build a DACL granting the current user full access ───────────
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: 0x001F_01FF, // FILE_ALL_ACCESS
            grfAccessMode: SET_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: TRUSTEE_W {
                TrusteeForm: TRUSTEE_IS_SID,
                // user_sid.0 is a raw pointer into token_user_buf, which is still alive
                ptstrName: PWSTR(user_sid.0.cast::<u16>()),
                ..Default::default()
            },
        };

        let acl = {
            let mut raw: *mut ACL = std::ptr::null_mut();
            // SAFETY: `access` is a fully initialised EXPLICIT_ACCESS_W entry.
            // SetEntriesInAclW allocates the ACL via LocalAlloc and writes its address into `raw`.
            unsafe {
                SetEntriesInAclW(Some(&[access]), None, std::ptr::addr_of_mut!(raw))
                    .ok()
                    .map_err(|e| Error::Config(format!("SetEntriesInAclW failed: {e:?}")))?;
            }
            LocalAlloced(raw) // ACL is now freed automatically on any early return
        };

        // ── Step 5: Apply the DACL to the target path ────────────────────────────
        // SAFETY: path_wide is a null-terminated UTF-16 string. acl.0 is a valid ACL
        // allocated by SetEntriesInAclW; it remains valid because `acl` has not been dropped.
        let result = unsafe {
            SetNamedSecurityInfoW(
                PWSTR(path_wide.as_mut_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                None,
                None,
                Some(acl.0),
                None,
            )
        };
        // `acl` is dropped here, freeing the LocalAlloc memory

        result
            .ok()
            .map_err(|e| Error::Config(format!("SetNamedSecurityInfoW failed: {e:?}")))
    }
}

#[cfg(windows)]
use win32_acl::set_secure_acl;

#[cfg(not(any(unix, windows)))]
fn set_secure_acl(_path: &Path) -> Result<()> {
    Ok(())
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_secure_file_permissions() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.txt");
        fs::write(&path, "test").unwrap();
        set_secure_file_permissions(&path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn test_secure_dir_permissions() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("secure");
        fs::create_dir_all(&path).unwrap();
        set_secure_dir_permissions(&path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }
}
