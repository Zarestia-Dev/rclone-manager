# Updater verification fixtures

These files are intentional, public test inputs and must remain in version control.

- `payload.txt`: harmless sample content, not an executable.
- `manifest.json`: version, product, target, size, hash, and payload signature.
- `manifest.json.sig`: a signature binding the manifest's metadata.
- `public.key`: the **public** verification key for these tests only.

The corresponding private key is not included. This public key is unrelated to
the production updater key and is never trusted by production installation code.
The fixtures were signed with the project's Tauri CLI. Tests verify valid data,
tampered content, incorrect keys, and mismatched product metadata without network
access or release secrets.

The payload signature is stored in `manifest.json`; no separate signature file
is needed for the payload.

`portable-catalog.json`, `portable-public.key`, and the three `portable-*.zip`
archives exercise the release producer and consumer together. Each ZIP contains
the harmless `payload.txt` under its platform's executable path and a sample
configuration or app bundle. Metadata, ZIP bytes, and executable bytes have
independent Tauri signatures from a separate disposable key. Tests check both
verification stages and full macOS bundle replacement/rollback, including
`Info.plist` and signature resources. The private key was discarded.

`process-app.sh`, `process-99.0.0.json`, `process-99.0.1.json`, their manifest
signatures, and `process-public.key` form a second fixture set. Linux x86_64
process tests install this signed shell script and exercise startup commitment,
crash recovery, tamper rejection, consecutive updates, and administrative stops.
The script simulates the application's startup receipt and update handoff. It
does not access user configuration or the network. Its disposable private key
is not included, and production helper entry points always use the production key.

Formatting or editing signed files invalidates their signatures. To replace them,
generate a disposable key outside the repository and sign the payload and manifest
again. Never add a production private key or Android keystore here.
