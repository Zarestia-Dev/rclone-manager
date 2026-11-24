const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createManifest, mergeCatalogs, MANIFEST_NAME } = require('./create-update-manifest.cjs');
const { checkRelease, publishCatalog, tauriUpdateJson } = require('./publish-custom-updater.cjs');

test('preflight permits new and draft releases and rejects published releases before uploads', () => {
  for (const tag of ['v1.2.3', 'headless-v1.2.3']) {
    for (const releases of [[], [{ tag_name: tag, draft: true }]]) {
      const calls = [];
      checkRelease(tag, '1.2.3', args => {
        calls.push(args);
        return releases.map(release => JSON.stringify(release)).join('\n');
      });
      assert.deepEqual(calls, [
        [
          'api',
          'repos/{owner}/{repo}/releases?per_page=100',
          '--paginate',
          '--jq',
          `.[] | select(.tag_name == ${JSON.stringify(tag)}) | {tag_name, draft}`,
        ],
      ]);
    }
    const calls = [];
    assert.throws(
      () =>
        checkRelease(tag, '1.2.3', args => {
          calls.push(args);
          return JSON.stringify({ tag_name: tag, draft: false });
        }),
      /published release/
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'api');
  }
});

test('preflight fails closed on API errors, malformed data and unexpected tags', () => {
  for (const response of [
    'not JSON',
    '{}',
    '[{}]',
    '[null]',
    '[[{"tag_name":"v1.2.3","draft":true}]]',
    '{"tag_name":"v1.2.3"}',
    '{"tag_name":"v1.2.3","draft":"true"}',
    '{"tag_name":"v9.0.0","draft":true}',
  ]) {
    assert.throws(() => checkRelease('v1.2.3', '1.2.3', () => response));
  }
  assert.throws(
    () =>
      checkRelease('v1.2.3', '1.2.3', () => {
        throw new Error('API unavailable');
      }),
    /API unavailable/
  );
  assert.throws(
    () =>
      checkRelease('v2.0.0', '1.2.3', () => {
        assert.fail('Invalid tags must not call GitHub');
      }),
    /Unexpected release tag/
  );
});

test('preflight handles empty pages and rejects published or invalid records on later lines', () => {
  const draft = JSON.stringify({ tag_name: 'v1.2.3', draft: true });
  checkRelease('v1.2.3', '1.2.3', () => `\n \n${draft}\n\n`);
  checkRelease('v1.2.3', '1.2.3', () => '\n \n');
  assert.throws(
    () =>
      checkRelease(
        'v1.2.3',
        '1.2.3',
        () => `${draft}\n${JSON.stringify({ tag_name: 'v1.2.3', draft: false })}\n`
      ),
    /published release/
  );
  assert.throws(
    () => checkRelease('v1.2.3', '1.2.3', () => `${draft}\n{}\n`),
    /Invalid release list/
  );
});

function catalog(kind, target = 'linux-x86_64', asset = `${kind}-${target}-1.2.3`) {
  const manifest = createManifest({
    kind,
    target,
    version: '1.2.3',
    asset,
    bytes: Buffer.from('abc'),
    signature: `${kind}-payload-signature`,
  });
  return {
    schemaVersion: 1,
    version: '1.2.3',
    entries: {
      [`${kind}-${target}`]: {
        manifest: Buffer.from(JSON.stringify(manifest)).toString('base64'),
        signature: 'manifest-signature',
      },
    },
  };
}

test('sends Tauri headless installs to the packages with the catalog signatures', () => {
  const merged = mergeCatalogs('1.2.3', [
    catalog('server'),
    catalog('deb', 'linux-x86_64', 'RClone.Manager.Server_1.2.3_amd64.deb'),
    catalog('nsis', 'windows-aarch64', 'RClone.Manager.Server_1.2.3_arm64-setup.exe'),
    catalog('msi', 'windows-aarch64', 'RClone.Manager.Server_1.2.3_arm64_en-US.msi'),
  ]);
  const json = tauriUpdateJson(merged, 'headless-v1.2.3', 'owner/repo');
  const download = 'https://github.com/owner/repo/releases/download/headless-v1.2.3/';
  assert.equal(json.version, '1.2.3');
  assert.ok(!Number.isNaN(Date.parse(json.pub_date)));
  assert.deepEqual(json.platforms, {
    'linux-x86_64-deb': {
      signature: 'deb-payload-signature',
      url: `${download}RClone.Manager.Server_1.2.3_amd64.deb`,
    },
    'windows-aarch64-nsis': {
      signature: 'nsis-payload-signature',
      url: `${download}RClone.Manager.Server_1.2.3_arm64-setup.exe`,
    },
    'windows-aarch64-msi': {
      signature: 'msi-payload-signature',
      url: `${download}RClone.Manager.Server_1.2.3_arm64_en-US.msi`,
    },
  });
  // Desktop and server releases keep their own updater files.
  assert.equal(tauriUpdateJson(catalog('server'), 'headless-v1.2.3', undefined), null);
  assert.throws(() => tauriUpdateJson(merged, 'headless-v1.2.3', undefined), /repository/);
});

test('refuses a catalog that names a file the release does not have', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rcman-merge-test-'));
  try {
    fs.writeFileSync(path.join(directory, MANIFEST_NAME), JSON.stringify(catalog('portable')));
    const publish = assets =>
      publishCatalog('v1.2.3', '1.2.3', directory, args => {
        if (args[1] === 'view') return JSON.stringify({ isDraft: true, assets });
        return '';
      });
    assert.throws(() => publish([]), /v1.2.3 has no portable-linux-x86_64-1.2.3/);
    // GitHub stores spaces as dots: a file uploaded under another name is missing.
    assert.throws(() => publish([{ name: 'portable linux-x86_64-1.2.3' }]), /has no/);
    publish([{ name: 'portable-linux-x86_64-1.2.3' }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves another workflow entries and uploads only the separate custom catalog', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rcman-merge-test-'));
  try {
    fs.mkdirSync(path.join(directory, 'linux'));
    fs.writeFileSync(
      path.join(directory, 'linux', MANIFEST_NAME),
      JSON.stringify(catalog('portable'))
    );
    const calls = [];
    const merged = publishCatalog('v1.2.3', '1.2.3', directory, args => {
      calls.push(args);
      if (args[1] === 'view')
        return JSON.stringify({
          isDraft: true,
          assets: [
            { name: MANIFEST_NAME },
            { name: 'latest.json' },
            { name: 'portable-linux-x86_64-1.2.3' },
            { name: 'server-linux-x86_64-1.2.3' },
          ],
        });
      if (args[1] === 'download') return JSON.stringify(catalog('server'));
      assert.equal(path.basename(args[3]), MANIFEST_NAME);
      assert.deepEqual(JSON.parse(fs.readFileSync(args[3], 'utf8')).entries, {
        ...catalog('server').entries,
        ...catalog('portable').entries,
      });
      return '';
    });
    assert.equal(Object.keys(merged.entries).length, 2);
    assert.deepEqual(
      calls.map(args => args[1]),
      ['view', 'download', 'upload']
    );
    assert.equal(fs.existsSync(calls[2][3]), false);
    assert.throws(
      () => publishCatalog('v1.2.3', '1.2.3', directory, () => JSON.stringify({ isDraft: false })),
      /published release/
    );
    assert.throws(() => publishCatalog('v2.0.0', '1.2.3', directory), /Unexpected release tag/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('creates the first catalog, rejects empty inputs and propagates download failures', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rcman-merge-test-'));
  try {
    assert.throws(
      () => publishCatalog('headless-v1.2.3', '1.2.3', directory),
      /No custom update catalogs/
    );
    fs.writeFileSync(path.join(directory, MANIFEST_NAME), JSON.stringify(catalog('server')));
    let uploaded = false;
    publishCatalog('headless-v1.2.3', '1.2.3', directory, args => {
      if (args[1] === 'view')
        return JSON.stringify({ isDraft: true, assets: [{ name: 'server-linux-x86_64-1.2.3' }] });
      assert.equal(args[1], 'upload');
      uploaded = true;
      return '';
    });
    assert.ok(uploaded);
    assert.throws(
      () =>
        publishCatalog('v1.2.3', '1.2.3', directory, args => {
          if (args[1] === 'view')
            return JSON.stringify({ isDraft: true, assets: [{ name: MANIFEST_NAME }] });
          throw new Error('download failed');
        }),
      /download failed/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
