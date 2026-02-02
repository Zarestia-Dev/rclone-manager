# Rclone RC API Limitations & Improvement Proposals

This document outlines current limitations in the Rclone Remote Control (RC) API and proposes specific improvements to enhance its capability, especially for headless and GUI wrappers.

---

## 1. Path Configuration vs. Cache/Temp Paths

- [ ] **Limitation**: `config/setpath` only accepts `path` (for the config file) and rejects `cache` or `temp`. One must use `options/set` to change `CacheDir`, but `config/paths` continues to report the old path (locked at startup), creating a disconnect between the API report and actual state.
- [ ] **Proposal**: Update `config/setpath` to accept `cache` and `temp`. Ensure that changes trigger a dynamic reload of these paths internally so `config/paths` reports the correct active paths immediately.

## 2. Encrypted Configuration Safely Detection

- [ ] **Limitation**: `config/get` returns the config if unlocked, but fails/hangs if locked. There is no safe, non-blocking way to just _check_ if the config is encrypted/locked without potentially hanging the process on an interactive prompt (if not suppressed).
- [ ] **Proposal**: Add a `config/status` endpoint that returns metadata:
  ```json
  { "encrypted": true, "locked": true, "path": "/..." }
  ```
  This allows clients to check status safely before deciding to prompt the user for a password.

## 3. Passive Password Prompt Blocking (Deadlock)

- [ ] **Limitation**: If an encrypted config is locked and an RC command tries to access it, Rclone halts and waits for input on `stdin`. This freezes the entire RC server.
  - Using `--ask-password=false` is not a viable workaround because it causes a **CRITICAL failure** at startup (`CRITICAL: Failed to load config file ...: unable to decrypt configuration and not allowed to ask for password`), crashing the process or preventing the RC server from even starting to receive `config/unlock`.
- [ ] **Proposal**: When running with `--rc`:
  1.  Default to non-interactive mode for config passwords.
  2.  **Fail fast** instead of crashing: Return a specific API error (e.g., `401 ConfigLocked`) if the config cannot be loaded, but keep the RC server running so `config/unlock` can be called.

## 4. Configuration Encryption Management via RC

- [ ] **Limitation**: No endpoints exist to encrypt an existing plain config, decrypt an encrypted one, or change the password.
- [ ] **Proposal**: Add endpoints:
  - `config/encrypt` (args: `password`)
  - `config/decrypt` (args: `password`)
  - `config/changepassword`

## 5. Importing Remote Configurations

- [ ] **Limitation**: Cannot "import" a full JSON configuration object (from `config/get` dump) into another instance easily. OAuth remotes (OneDrive, iCloud, etc.) are complex to reconstruct via atomic `config/create` calls without re-triggering auth flows.
- [ ] **Proposal**:
  - Add a `raw` or `blob` parameter to `config/create` to accept a full JSON dump.
  - Or add `config/import` to merge a standard config section or JSON object directly.

## 6. Process Restart Capability

- [ ] **Limitation**: `core/quit` exists, but there is no `core/restart`.
- [ ] **Proposal**: Add `core/restart` to gracefully shut down and respawn the Rclone process with the exact same initial arguments. This is essential for applying setting changes that require a reboot (like mount flags or environment variables).

## 7. Multiple VFS Instance Addressing

- [ ] **Limitation**: When multiple mounts exists for the same remote, `vfs/list` shows unique IDs (e.g., `remote:[0]`, `remote:[1]`). However, commands like `vfs/stats`, `vfs/refresh`, `vfs/forget` often reject these suffixed names and ambiguous requests fail.
- [ ] **Proposal**: Standardize VFS answering. All `vfs/*` commands should accept the unique IDs returned by `vfs/list` to target specific mount instances reliably.

## 8. Self Update via RC

- [ ] **Limitation**: There is no command in RC to update the remote rclone instance (equivalent to `rclone selfupdate`). This prevents managing the rclone version of remote or headless instances via the API.
- [ ] **Proposal**: Add `core/selfupdate` (or similar) endpoint to trigger a self-update operation on the running instance. After update, the instance should restart automatically with the same arguments.
