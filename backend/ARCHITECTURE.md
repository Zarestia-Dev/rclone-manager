# Rust workspace

All Rust code lives under `backend/`. The workspace has one lockfile and three crates:

Workspace-wide formatting, lint configuration, and generated-artifact exclusions
live in `backend/rustfmt.toml`, `backend/.clippy.toml`, and `backend/.gitignore`.
Tauri schemas are excluded by `desktop/.gitignore`. Keep Tauri manifests, icons,
OS packaging files, and Android sources in `desktop`; they are not core resources.

```text
backend/
├── Cargo.toml, Cargo.lock
├── core/                  Shared application, independent of Tauri and Axum
│   ├── src/app/           Bootstrap, command catalog and JSON dispatch
│   ├── src/services/      Settings, security, automation, workflows and lifecycle
│   ├── src/rclone/        Engine, transports, operations, binaries and caches
│   ├── src/context/       Shared state ownership and host contract
│   ├── src/utils/         Shared types, helpers and OS utilities
│   ├── resources/         OAuth, serve and send_to templates
│   └── build.rs           librclone compilation and linking
├── server/                Tokio/Axum executable and reusable HTTP host
│   ├── README.md          Server deployment guide
│   ├── linux/             Standalone systemd service template
│   ├── src/headless/      Process startup, signals, paths and restart
│   └── src/web/           Routes, authentication, SSE and HTTP handlers
└── desktop/               Tauri application, including mobile and packaging
    ├── src/app.rs         Native composition; optionally starts the HTTP host
    ├── src/context.rs     Access to shared state from Tauri handles
    ├── src/native/        IPC, plugins, webview, notifications and updater adapter
    ├── src/desktop/       Windows, tray, autostart and portable paths
    ├── gen/android/      Android application
    └── tauri.conf*.json   Native resources and packaging configuration
```

Dependency direction: `desktop → core`, `server → core`. The optional desktop
`web-server` feature also enables `desktop → server` to compose HTTP with a native
tray. Core never imports either executable or their frameworks.

## Adding features

- Put shared operations in `core/src/services` or `core/src/rclone`. Register commands
  in `core/src/app/commands.rs`. The JSON dispatcher is used by both HTTP and IPC,
  preserving camelCase arguments and structured errors. Native-only commands
  belong in `desktop/src/native/ipc.rs`.
- Shared `AppHandle` owns typed state and an injected `Host`. Native code accesses
  that same context through `BackendContext`; do not register copies of business
  state in Tauri. The context lives in `core/src/context`; its state methods are inherent
  methods, with no separate Manager trait. `State<T>` owns an `Arc<T>`, so it
  does not borrow the context. Host capabilities supply paths, exit/restart, theme, tray,
  notifications and update checks.
- `EventSink` delivers shared events to native webviews. HTTP subscribes to the
  broadcast channel and forwards only `SSE_FORWARD_EVENTS`. Keep internal event
  subscriptions in `core/src/services/event_listener.rs`.
- App update checks and installation live in `core/src/services/updates`;
  `AppUpdate` abstracts platform installers. Rclone provisioning, downloads and
  binary updates live in `core/src/rclone/binaries`. Generated RC endpoints belong
  to `core/src/rclone/endpoints.rs`.
- Keep translations in the repository's `resources/i18n` directory. The settings
  namespace remains `rclone-manager`; crate names do not change user data paths.
- Keep target-specific dependencies in their owning crate. Source boundary tests
  in `core/tests/architecture.rs` guard the separation.

## Commands (from repository root)

```sh
npm run tauri dev
npm run dev:portable
npm run dev:android
npm run dev:headless       # Native tray + HTTP server
npm run dev:server         # Pure Tokio server, no Tauri/GTK/WebKit
npm run build:server
cargo fmt --manifest-path backend/Cargo.toml --all -- --check
cargo clippy --manifest-path backend/Cargo.toml -p rclone-manager-server -- -D warnings
cargo clippy --manifest-path backend/Cargo.toml -p rclone-manager -- -D warnings
```

The npm Tauri wrapper supplies explicit native and frontend paths. Direct Tauri
CLI integrations should set `TAURI_APP_PATH` to `backend/desktop` and
`TAURI_FRONTEND_PATH` to the repository root (absolute paths).

Cargo outputs go to `backend/target`. Pure server releases use the
`rclone-manager-server` binary with embedded Angular UI, backend translations,
and shared HTML templates. Builds with `debug_assertions` serve the UI from disk;
builds without it embed `dist/rclone-manager/browser` at compile time.
The `desktop` directory also owns mobile because both use Tauri; it is not a
fourth copy of application logic. `LIBRCLONE_SKIP_LINK_CHECK=1` permits mobile
static checks without verifying the Go archive or device behavior.

## Dependency ownership

`server` and `desktop` expose their entry points, not copies of the core API.
Consumers import shared types directly from `rclone_manager_core`. Within the
adapters, crate-private imports keep source paths concise.

The state registry is a startup composition mechanism. Register services once
in `app/setup.rs`; `manage` preserves an existing registration. Use `state` for
required startup dependencies and `try_state` for optional capabilities. Prefer
explicit service arguments for new domain helpers rather than passing the entire
context when only one service is needed.

`Host` defaults describe optional native capabilities: standalone servers do not
have a tray, theme monitor, or native updater. Required paths and restart behavior
must be implemented. Avoid adding a new trait per method; split capabilities only
when an actual independent implementation needs them.

The `services` directory owns settings, automation, workflows, security and
application lifecycle. `rclone` owns engine operations, transports and binary provisioning.

OAuth and serve templates belong to `core/resources`. Core embeds them for all
hosts, including desktop, portable, and server. Release builds materialize them
atomically under the app cache when Rclone needs a file path; debug builds use
the source files. Backend translations come from the canonical `resources/i18n`
sources and are embedded in release builds, with only backend sections cached.
Portable packages need no adjacent translation or template directory; user data
and the separately managed Rclone executable remain writable files.

## macOS packaging

Native releases use direct `.app`/DMG distribution, without App Sandbox.
Both Tauri configurations reference `desktop/entitlements.plist`; Tauri merges
`desktop/Info.plist` into the application bundle. Apple Events access supports
explicitly configured shutdown actions through System Events. Camera and
microphone capabilities are not requested. Dock visibility is controlled by
`desktop/src/native/dock.rs`, rather than a static `LSUIElement` override.

Rclone mounts use an installed macFUSE/FUSE-T implementation. Apple File Provider
would require a separate extension; adding an entitlement alone does not enable
it. Signing/notarization credentials and macOS permission prompts remain part of
the macOS release and runtime environment.

## Lifecycle and feature composition

Standalone server startup owns SIGINT/SIGTERM handling (Ctrl+C on non-Unix
platforms). Exit requests stop HTTP acceptance, with a five-second drain limit
for persistent connections. Shared cleanup waits for in-flight initialization,
then stops jobs, mounts, serves and the engine. Concurrent cleanup callers await
one completion; initialization cannot restart after shutdown has begun. The
standalone process bounds cleanup to twenty seconds and its final HTTP task wait
to six seconds. Embedded HTTP startup does not install process signal handlers.

Cargo unifies core features when desktop and server are selected together.
Shared schema fields use positive desktop capability checks; enabling HTTP must
not remove fields needed by a desktop consumer. Check this composition with:

```sh
cargo clippy --manifest-path backend/Cargo.toml -p rclone-manager -p rclone-manager-server --all-targets -- -D warnings
```

## Desktop and server product boundaries

Each executable supplies immutable `ProductInfo` when constructing the shared
context: display name, debug mode, release tag prefix and OS integration IDs.
Shared update filtering and Send To registration consume these values directly;
`Host` contains OS operations, not a desktop/headless identity query. Existing
shortcut names, debug labels and release tag families remain unchanged.

Core's CLI module contains only shared path and Send To arguments. The server
owns `HttpArgs` (host, port, authentication and TLS). Desktop owns its CLI parser
and `--tray`, and includes `HttpArgs` only in its tray/server build. No options
need to be hidden or rejected after parsing to compensate for unified features.
The server starts from `HttpArgs`, not an entire executable's CLI structure.

Core has no `web-server` feature. Desktop retains that feature because it selects
its native tray/server composition and optional server dependency. Native tray
startup policy belongs to the native host; shared initialization invokes the
optional host capability without reading native CLI flags.

`AppPaths::setup` resolves host paths during startup, creates directories, and
registers the successful result before native preparation. Later readers use that
registered snapshot; a read before setup returns an error. Repeated setup reuses
the registered paths, and a failed setup can be retried.

Exit confirmation returns `ExitDecision::Proceed` or `ExitDecision::Deferred`.
Desktop defers cleanup while its UI waits for confirmation. Hosts without a
confirmation UI proceed with the shared shutdown sequence.

Workflow internals and multi-context/global-state redesign remain outside this
host-boundary work.
