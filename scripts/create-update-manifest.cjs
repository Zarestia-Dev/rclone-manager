/* Sign release artifacts and their metadata in one custom update catalog. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const MANIFEST_NAME = 'updater.json';
const MAX_MANIFEST_SIZE = 64 * 1024;

const MAX_ARTIFACT_SIZE = 512 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

function requireFields(value, required, optional = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some(field => !Object.hasOwn(value, field)) ||
    Object.keys(value).some(field => !required.includes(field) && !optional.includes(field))
  )
    throw new Error('Invalid update metadata fields');
}

function validateSize(size) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ARTIFACT_SIZE)
    throw new Error('Invalid artifact size');
}

function validateIdentity({ kind, target, version, asset }) {
  if (!['portable', 'server', 'android'].includes(kind)) throw new Error('Invalid update kind');
  if (
    typeof target !== 'string' ||
    !/^(linux|windows|macos|android)-(x86_64|aarch64|armv7|i686)$/.test(target)
  )
    throw new Error('Invalid update target');
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('Invalid version');
  if (typeof asset !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,159}$/.test(asset))
    throw new Error('Invalid asset name');
}

function validateArtifact({ size, sha256, signature }) {
  validateSize(size);
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error('Invalid artifact checksum');
  if (typeof signature !== 'string' || !signature.trim())
    throw new Error('Missing artifact signature');
}

function validateArchivePath({ kind, target, asset }, binaryPath) {
  if (
    !['portable', 'server'].includes(kind) ||
    !/^(windows|linux|macos)-/.test(target) ||
    !asset.endsWith('.zip') ||
    typeof binaryPath !== 'string' ||
    binaryPath.includes('\\') ||
    binaryPath.includes(':') ||
    /[\p{Cc}]/u.test(binaryPath) ||
    binaryPath.split('/').some(part => ['', '.', '..'].includes(part)) ||
    (kind === 'portable' &&
      target.startsWith('macos-') &&
      !/^[^/]+\.app\/Contents\/MacOS\/rclone-manager$/.test(binaryPath))
  )
    throw new Error('Invalid update archive metadata');
}

function validateManifest(manifest) {
  requireFields(
    manifest,
    ['version', 'kind', 'target', 'asset', 'size', 'sha256', 'signature'],
    ['archive']
  );
  validateIdentity(manifest);
  validateArtifact(manifest);
  if (manifest.archive != null) {
    requireFields(manifest.archive, ['binaryPath', 'size', 'sha256', 'signature']);
    validateArchivePath(manifest, manifest.archive.binaryPath);
    validateArtifact(manifest.archive);
  }
  return manifest;
}

// Keep the exact signed bytes: parsing and re-serializing them invalidates the signature.
function mergeCatalogs(version, catalogs) {
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('Invalid version');
  const result = { schemaVersion: 1, version, entries: {} };
  for (const catalog of catalogs) {
    requireFields(catalog, ['schemaVersion', 'version', 'entries']);
    if (
      catalog.schemaVersion !== 1 ||
      catalog.version !== version ||
      !catalog.entries ||
      typeof catalog.entries !== 'object' ||
      Array.isArray(catalog.entries)
    )
      throw new Error('Invalid custom update catalog');
    for (const [id, entry] of Object.entries(catalog.entries)) {
      requireFields(entry, ['manifest', 'signature']);
      if (
        typeof entry.manifest !== 'string' ||
        typeof entry.signature !== 'string' ||
        !entry.signature.trim()
      )
        throw new Error('Missing signed manifest');
      const bytes = Buffer.from(entry.manifest, 'base64');
      if (bytes.toString('base64') !== entry.manifest) throw new Error('Invalid manifest encoding');
      const manifest = validateManifest(JSON.parse(bytes.toString('utf8')));
      if (manifest.version !== version || id !== `${manifest.kind}-${manifest.target}`)
        throw new Error('Mismatched custom update entry');
      result.entries[id] = entry;
    }
  }
  if (Buffer.byteLength(JSON.stringify(result, null, 2) + '\n') > MAX_MANIFEST_SIZE)
    throw new Error('Custom update catalog exceeds size limit');
  return result;
}

function createManifest({ kind, target, version, asset, bytes, signature, archive }) {
  return validateManifest({
    version,
    kind,
    target,
    asset,
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    signature: typeof signature === 'string' ? signature.trim() : signature,
    ...(archive ? { archive } : {}),
  });
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

function publish(kind, os, arch, version, input, output, archiveFile, binaryPath) {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY)
    throw new Error('Production updates require TAURI_SIGNING_PRIVATE_KEY');
  if (kind === 'server' && !archiveFile) throw new Error('Server updates must be ZIP archives');
  const target = `${os}-${arch}`;
  const extension = archiveFile
    ? '.zip'
    : os === 'android'
      ? '.apk'
      : os === 'windows'
        ? '.exe'
        : '';
  const prefix = kind === os ? target : `${kind}-${target}`;
  const asset = `${prefix}-${version}${extension}`;
  const bytes = fs.readFileSync(input);
  // Validate all untrusted arguments before using them in output paths.
  validateIdentity({ kind, target, version, asset });
  validateSize(bytes.length);
  if (archiveFile) validateArchivePath({ kind, target, asset }, binaryPath);
  fs.mkdirSync(output, { recursive: true });
  const payload = path.resolve(output, asset);
  const temporary = fs.mkdtempSync(path.join(tmpdir(), 'rcman-manifest-'));
  try {
    const source = archiveFile || input;
    if (path.resolve(source) !== payload) fs.copyFileSync(source, payload);
    const payloadSignature = sign(payload);
    let signature = payloadSignature;
    let archive;
    if (archiveFile) {
      const binary = path.join(temporary, 'binary');
      fs.copyFileSync(input, binary);
      signature = sign(binary);
      const archiveBytes = fs.readFileSync(payload);
      archive = {
        binaryPath,
        size: archiveBytes.length,
        sha256: crypto.createHash('sha256').update(archiveBytes).digest('hex'),
        signature: payloadSignature,
      };
    }
    const manifest = createManifest({ kind, target, version, asset, bytes, signature, archive });
    const manifestFile = path.join(temporary, 'manifest.json');
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(manifestFile, manifestBytes);
    const entry = {
      manifest: Buffer.from(manifestBytes).toString('base64'),
      signature: sign(manifestFile),
    };
    const catalogFile = path.resolve(output, MANIFEST_NAME);
    const existing = fs.existsSync(catalogFile)
      ? [JSON.parse(fs.readFileSync(catalogFile, 'utf8'))]
      : [];
    const catalog = mergeCatalogs(version, [
      ...existing,
      { schemaVersion: 1, version, entries: { [`${kind}-${target}`]: entry } },
    ]);
    fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
    // Signatures are embedded in the catalog; no sidecars are published.
    fs.unlinkSync(`${payload}.sig`);
    return manifest;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (![6, 8].includes(args.length))
      throw new Error(
        'Usage: create-update-manifest kind os arch version input output [archive binary-path]'
      );
    publish(...args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = {
  createManifest,
  validateManifest,
  publish,
  mergeCatalogs,
  MANIFEST_NAME,
  MAX_MANIFEST_SIZE,
};
