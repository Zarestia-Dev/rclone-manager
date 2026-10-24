const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createManifest, MANIFEST_NAME } = require('./create-update-manifest.cjs');
const { checkRelease, publishCatalog } = require('./publish-custom-updater.cjs');

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

function catalog(kind) {
  const manifest = createManifest({
    kind,
    target: 'linux-x86_64',
    version: '1.2.3',
    asset: `${kind}-linux-x86_64-1.2.3`,
    bytes: Buffer.from('abc'),
    signature: 'payload-signature',
  });
  return {
    schemaVersion: 1,
    version: '1.2.3',
    entries: {
      [`${kind}-linux-x86_64`]: {
        manifest: Buffer.from(JSON.stringify(manifest)).toString('base64'),
        signature: 'manifest-signature',
      },
    },
  };
}

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
          assets: [{ name: MANIFEST_NAME }, { name: 'latest.json' }],
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
      if (args[1] === 'view') return JSON.stringify({ isDraft: true, assets: [] });
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
