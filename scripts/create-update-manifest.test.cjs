const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createManifest,
  validateManifest,
  mergeCatalogs,
  publish,
  MANIFEST_NAME,
} = require('./create-update-manifest.cjs');
const input = {
  kind: 'server',
  target: 'linux-x86_64',
  version: '1.2.3',
  asset: 'server-linux-x86_64-1.2.3',
  bytes: Buffer.from('abc'),
  signature: 'signature\n',
};

test('manifest binds the signed artifact to product, version, size and hash', () => {
  const manifest = createManifest(input);
  assert.equal(manifest.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(manifest.size, 3);
  assert.equal(manifest.signature, 'signature');
  assert.equal(manifest.kind, 'server');
  assert.equal(manifest.version, '1.2.3');
});

test('rejects unsafe names, unsupported platforms, empty payloads and missing signatures', () => {
  for (const override of [
    { asset: '../app' },
    { asset: 'a/b' },
    { asset: '.app' },
    { kind: '../portable' },
    { target: 'linux-other' },
    { version: '../1.2.3' },
    { bytes: Buffer.alloc(0) },
    { signature: '' },
  ]) {
    assert.throws(() => createManifest({ ...input, ...override }));
  }
  assert.equal(createManifest({ ...input, version: '1.2.3-beta.1' }).version, '1.2.3-beta.1');
});

test('validates real manifest fields without a synthetic payload', () => {
  const manifest = createManifest(input);
  assert.equal(validateManifest(manifest), manifest);
  for (const override of [
    { unexpected: true },
    { version: null },
    { target: null },
    { asset: null },
    { size: '3' },
    { size: 0 },
    { size: 1.5 },
    { size: 512 * 1024 * 1024 + 1 },
    { sha256: 'A'.repeat(64) },
    { sha256: null },
    { signature: 123 },
    { signature: ' ' },
    { archive: {} },
  ])
    assert.throws(() => validateManifest({ ...manifest, ...override }));
  for (const field of Object.keys(manifest)) {
    const missing = { ...manifest };
    delete missing[field];
    assert.throws(() => validateManifest(missing));
  }
  assert.throws(() => validateManifest(null));
  assert.throws(() => validateManifest([]));
});

test('accepts Rust fixtures and rejects unknown catalog, entry, and archive fields', () => {
  const fixtures = path.join(__dirname, '../backend/core/src/services/updates/fixtures');
  const source = JSON.parse(fs.readFileSync(path.join(fixtures, 'portable-catalog.json'), 'utf8'));
  assert.equal(Object.keys(mergeCatalogs(source.version, [source]).entries).length, 3);
  for (const change of [
    c => {
      c.unexpected = true;
    },
    c => {
      Object.values(c.entries)[0].unexpected = true;
    },
    c => {
      const entry = Object.values(c.entries)[0];
      const manifest = JSON.parse(Buffer.from(entry.manifest, 'base64'));
      manifest.unexpected = true;
      entry.manifest = Buffer.from(JSON.stringify(manifest)).toString('base64');
    },
    c => {
      const entry = Object.values(c.entries)[0];
      const manifest = JSON.parse(Buffer.from(entry.manifest, 'base64'));
      manifest.archive.unexpected = true;
      entry.manifest = Buffer.from(JSON.stringify(manifest)).toString('base64');
    },
  ]) {
    const catalog = structuredClone(source);
    change(catalog);
    assert.throws(() => mergeCatalogs(source.version, [catalog]));
  }
  const manifest = JSON.parse(
    Buffer.from(source.entries['portable-macos-aarch64'].manifest, 'base64')
  );
  for (const binaryPath of [
    '',
    '../binary',
    'a\\b',
    'a\u0085b',
    '.app/Contents/MacOS/rclone-manager',
  ]) {
    assert.throws(() =>
      validateManifest({ ...manifest, archive: { ...manifest.archive, binaryPath } })
    );
  }
});

function catalog(overrides = {}) {
  const manifest = createManifest({ ...input, ...overrides });
  return {
    schemaVersion: 1,
    version: manifest.version,
    entries: {
      [`${manifest.kind}-${manifest.target}`]: {
        manifest: Buffer.from(JSON.stringify(manifest, null, 2) + '\n').toString('base64'),
        signature: 'manifest-signature',
      },
    },
  };
}

test('merges products and architectures without changing signed bytes, and supports target rebuilds', () => {
  const portable = catalog({ kind: 'portable' });
  const android = catalog({ kind: 'android', target: 'android-aarch64' });
  const rebuilt = catalog({ kind: 'portable', bytes: Buffer.from('rebuilt') });
  const merged = mergeCatalogs('1.2.3', [
    portable,
    android,
    catalog({ target: 'linux-aarch64' }),
    rebuilt,
  ]);
  assert.equal(Object.keys(merged.entries).length, 3);
  assert.deepEqual(
    merged.entries['android-android-aarch64'],
    android.entries['android-android-aarch64']
  );
  assert.deepEqual(
    merged.entries['portable-linux-x86_64'],
    rebuilt.entries['portable-linux-x86_64']
  );
});

test('rejects wrong versions, malformed entries, mismatched targets and oversized catalogs', () => {
  const mutate = fn => {
    const value = catalog();
    fn(value);
    return value;
  };
  for (const invalid of [
    null,
    { ...catalog(), schemaVersion: 2 },
    { ...catalog(), version: '2.0.0' },
    { ...catalog(), entries: [] },
    mutate(c => {
      c.entries['server-linux-x86_64'].signature = '';
    }),
    mutate(c => {
      c.entries['server-linux-x86_64'].manifest = '%%%';
    }),
    mutate(c => {
      c.entries['portable-linux-x86_64'] = c.entries['server-linux-x86_64'];
    }),
    mutate(c => {
      c.entries['server-linux-x86_64'].signature = 'x'.repeat(65536);
    }),
  ])
    assert.throws(() => mergeCatalogs('1.2.3', [invalid]));
  assert.throws(() => mergeCatalogs('../version', []));
});

test('publishes multiple signed targets into one catalog without signature sidecars', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rcman-publish-test-'));
  const previousKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
  const previousPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  try {
    const key = path.join(directory, 'test.key');
    const generated = spawnSync(process.execPath, [
      path.join(__dirname, 'tauri.cjs'),
      'signer',
      'generate',
      '-p',
      '',
      '-w',
      key,
    ]);
    assert.equal(generated.status, 0, generated.stderr?.toString());
    process.env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(key, 'utf8');
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
    const inputFile = path.join(directory, 'payload');
    const output = path.join(directory, 'output');
    fs.writeFileSync(inputFile, 'abc');
    publish('server', 'linux', 'x86_64', '1.2.3', inputFile, output);
    publish('server', 'linux', 'aarch64', '1.2.3', inputFile, output);
    publish('server', 'macos', 'aarch64', '1.2.3', inputFile, output);
    publish('server', 'windows', 'x86_64', '1.2.3', inputFile, output);
    publish('portable', 'linux', 'x86_64', '1.2.3', inputFile, output);
    publish('android', 'android', 'aarch64', '1.2.3', inputFile, output);
    assert.deepEqual(
      fs.readdirSync(output).sort(),
      [
        'android-aarch64-1.2.3.apk',
        MANIFEST_NAME,
        'portable-linux-x86_64-1.2.3',
        'server-linux-aarch64-1.2.3',
        'server-linux-x86_64-1.2.3',
        'server-macos-aarch64-1.2.3',
        'server-windows-x86_64-1.2.3.exe',
      ].sort()
    );
    const merged = mergeCatalogs('1.2.3', [
      JSON.parse(fs.readFileSync(path.join(output, MANIFEST_NAME), 'utf8')),
    ]);
    assert.equal(Object.keys(merged.entries).length, 6);
    for (const entry of Object.values(merged.entries)) {
      assert.ok(entry.signature.length > 100);
      const manifest = JSON.parse(Buffer.from(entry.manifest, 'base64'));
      assert.equal(manifest.sha256, createManifest(input).sha256);
      assert.equal(fs.readFileSync(path.join(output, manifest.asset), 'utf8'), 'abc');
    }
    // Portable releases expose only ZIP packages; each signed record also binds its binary.
    const fixtures = path.join(__dirname, '../backend/core/src/services/updates/fixtures');
    const zipOutput = path.join(directory, 'zip-output');
    const payload = fs.readFileSync(path.join(fixtures, 'payload.txt'));
    fs.writeFileSync(inputFile, payload);
    for (const [os, arch, member] of [
      ['windows', 'x86_64', 'RCloneManager/RCloneManager.exe'],
      ['linux', 'x86_64', 'RCloneManager/RCloneManager'],
      ['macos', 'aarch64', 'RClone Manager.app/Contents/MacOS/rclone-manager'],
    ]) {
      const archive = path.join(fixtures, `portable-${os}-${arch}-99.0.0.zip`);
      const manifest = publish(
        'portable',
        os,
        arch,
        '1.2.3',
        inputFile,
        zipOutput,
        archive,
        member
      );
      assert.equal(manifest.asset, `portable-${os}-${arch}-1.2.3.zip`);
      assert.equal(manifest.size, payload.length);
      assert.equal(manifest.archive.binaryPath, member);
      assert.equal(manifest.archive.size, fs.statSync(archive).size);
      assert.ok(manifest.archive.signature.length > 100);
      assert.notEqual(manifest.signature, manifest.archive.signature);
    }
    assert.deepEqual(
      fs.readdirSync(zipOutput).sort(),
      [
        MANIFEST_NAME,
        'portable-linux-x86_64-1.2.3.zip',
        'portable-macos-aarch64-1.2.3.zip',
        'portable-windows-x86_64-1.2.3.zip',
      ].sort()
    );
  } finally {
    if (previousKey === undefined) delete process.env.TAURI_SIGNING_PRIVATE_KEY;
    else process.env.TAURI_SIGNING_PRIVATE_KEY = previousKey;
    if (previousPassword === undefined) delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
    else process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = previousPassword;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
