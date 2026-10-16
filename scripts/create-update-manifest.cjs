/* Publish raw, signed artifacts without extracting over user configuration. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function createManifest({ kind, target, version, asset, bytes, signature }) {
  if (!['portable', 'server', 'android'].includes(kind)) throw new Error('Invalid update kind');
  if (!/^(linux|windows|macos|android)-(x86_64|aarch64|armv7|i686)$/.test(target)) {
    throw new Error('Invalid update target');
  }
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid version');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(asset)) throw new Error('Invalid asset name');
  if (!bytes.length || bytes.length > 512 * 1024 * 1024) throw new Error('Invalid artifact size');
  if (!signature?.trim()) throw new Error('Missing artifact signature');
  return {
    version,
    kind,
    target,
    asset,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    signature: signature.trim(),
  };
}

function sign(file) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, 'tauri.cjs'),
      'signer',
      'sign',
      '-p',
      process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '',
      file,
    ],
    { stdio: 'inherit' }
  );
  if (result.status !== 0) throw new Error('Update signing failed');
  return fs.readFileSync(`${file}.sig`, 'utf8').trim();
}

function publish(kind, os, arch, version, input, output) {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY)
    throw new Error('Production updates require TAURI_SIGNING_PRIVATE_KEY');
  const target = `${os}-${arch}`;
  const extension = os === 'android' ? '.apk' : os === 'windows' ? '.exe' : '.bin';
  const asset = `${kind}-${target}-${version}${extension}`;
  const bytes = fs.readFileSync(input);
  // Validate all untrusted arguments before using them in output paths.
  createManifest({ kind, target, version, asset, bytes, signature: 'pending' });
  fs.mkdirSync(output, { recursive: true });
  const payload = path.resolve(output, asset);
  fs.copyFileSync(input, payload);
  const signature = sign(payload);
  const manifest = createManifest({ kind, target, version, asset, bytes, signature });
  const manifestFile = path.resolve(output, `${kind}-${target}.json`);
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  sign(manifestFile);
  return manifest;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6)
      throw new Error('Usage: create-update-manifest kind os arch version input output');
    publish(...args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { createManifest, publish };
