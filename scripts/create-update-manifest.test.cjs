const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createManifest } = require('./create-update-manifest.cjs');
const input = {
  kind: 'server',
  target: 'linux-x86_64',
  version: '1.2.3',
  asset: 'server-linux-x86_64-1.2.3.bin',
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
