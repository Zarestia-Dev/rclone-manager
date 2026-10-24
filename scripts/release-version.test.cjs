const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  parseVersion,
  androidVersionCode,
  androidBuildArgs,
  releaseMetadata,
} = require('./release-version.cjs');

function configDirectory(t, version = '0.3.4-beta.1') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rcman-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'tauri.conf.json'), JSON.stringify({ version }));
  return directory;
}

test('classifies every SemVer prerelease without treating stable versions as prereleases', t => {
  const directory = configDirectory(t);
  const file = path.join(directory, 'tauri.conf.json');
  for (const version of [
    '0.3.4-beta.1',
    '0.3.4-rc.2',
    '0.3.4-dev',
    '0.3.4-preview.1',
    '0.3.4-custom.1',
  ]) {
    fs.writeFileSync(file, JSON.stringify({ version }));
    assert.deepEqual(releaseMetadata(file), { VERSION: version, PRERELEASE: 'true' });
  }
  fs.writeFileSync(file, JSON.stringify({ version: '0.3.4' }));
  assert.deepEqual(releaseMetadata(file), { VERSION: '0.3.4', PRERELEASE: 'false' });
});

test('rejects malformed versions, leading zeroes, unsafe numbers and multiline output injection', () => {
  for (const version of [
    null,
    undefined,
    '',
    'v0.3.4',
    '0.3',
    '0.03.4',
    '0.3.4-beta.01',
    '0.3.4-',
    '0.3.4-beta..1',
    '0.3.4+metadata',
    '0.3.4\nPRERELEASE=false',
    '99999999999999999999.0.0',
  ]) {
    assert.throws(() => parseVersion(version), /Invalid release version/);
  }
});

test('Android numbering increases from legacy stable through successive betas and stable', () => {
  const versions = [
    '0.3.3',
    '0.3.4-alpha',
    '0.3.4-alpha.0',
    '0.3.4-alpha.197',
    '0.3.4-beta',
    '0.3.4-beta.0',
    '0.3.4-beta.1',
    '0.3.4-beta.2',
    '0.3.4-beta.10',
    '0.3.4-beta.197',
    '0.3.4-dev',
    '0.3.4-preview',
    '0.3.4-rc',
    '0.3.4-rc.197',
    '0.3.4',
    '0.3.5-alpha',
  ];
  let previous = 3003; // Existing Tauri-derived 0.3.3 release.
  for (const version of versions) {
    const code = androidVersionCode(version);
    assert.ok(code > previous, `${version}: ${code} must exceed ${previous}`);
    previous = code;
  }
  assert.equal(androidVersionCode('0.3.4-beta.1'), 304202);
  assert.equal(androidVersionCode('0.3.4-beta.2'), 304203);
  assert.equal(androidVersionCode('0.3.4'), 304999);
  assert.ok(androidVersionCode('0.4.0-alpha') > androidVersionCode('0.3.99'));
  assert.ok(androidVersionCode('1.0.0-alpha') > androidVersionCode('0.99.99'));
});

test('Android codes are reproducible and reject unsupported forms and overflow', () => {
  assert.equal(androidVersionCode('0.3.4-beta.1'), androidVersionCode('0.3.4-beta.1'));
  assert.equal(androidVersionCode('209.99.99'), 2099999999);
  for (const version of [
    '0.3.4-beta.198',
    '0.3.4-beta.9007199254740991',
    '0.3.4-beta1',
    '0.3.4-nightly.1',
    '0.3.4-beta.1.hotfix',
    '0.100.0',
    '0.3.100',
    '210.0.0',
    '0.0.0-alpha',
  ]) {
    assert.throws(() => androidVersionCode(version));
  }
});

test('only Android dev/build commands receive the generated config before Cargo args', t => {
  const directory = configDirectory(t);
  for (const args of [
    [],
    ['build'],
    ['android', 'init'],
    ['android', 'build', '--features', 'mobile', '--', '--no-default-features'],
  ]) {
    const actual = androidBuildArgs(args, directory);
    if (args[0] !== 'android' || args[1] !== 'build') {
      assert.deepEqual(actual, args);
      continue;
    }
    assert.deepEqual(actual.slice(-2), ['--', '--no-default-features']);
    const override = JSON.parse(actual[actual.indexOf('--config') + 1]);
    assert.deepEqual(override, {
      bundle: { android: { versionCode: 304202, autoIncrementVersionCode: false } },
    });
    assert.deepEqual(args, [
      'android',
      'build',
      '--features',
      'mobile',
      '--',
      '--no-default-features',
    ]);
  }
  assert.ok(androidBuildArgs(['android', 'dev'], directory).includes('--config'));
});

test('Android numbering uses platform and CLI version overrides in merge order', t => {
  const directory = configDirectory(t);
  fs.writeFileSync(
    path.join(directory, 'tauri.android.conf.json'),
    JSON.stringify({ version: '0.3.4-beta.2' })
  );
  const code = args =>
    JSON.parse(args[args.lastIndexOf('--config') + 1]).bundle.android.versionCode;
  assert.equal(code(androidBuildArgs(['android', 'build'], directory)), 304203);
  const custom = path.join(directory, 'custom.json');
  fs.writeFileSync(custom, JSON.stringify({ version: '0.3.4-rc.1' }));
  assert.equal(code(androidBuildArgs(['android', 'build', '-c', custom], directory)), 304802);
  assert.equal(
    code(androidBuildArgs(['android', 'build', '--config={"version":"0.3.4"}'], directory)),
    304999
  );
  assert.equal(
    code(
      androidBuildArgs(
        ['android', 'build', '--config', custom, '--config', '{"version":"0.3.5"}'],
        directory
      )
    ),
    305999
  );
});

test('metadata CLI writes GitHub outputs and fails without partial output on invalid input', t => {
  const directory = configDirectory(t);
  const file = path.join(directory, 'tauri.conf.json');
  const output = path.join(directory, 'output');
  const cli = path.join(__dirname, 'release-version.cjs');
  const result = spawnSync(process.execPath, [cli, file], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(output, 'utf8'), 'VERSION=0.3.4-beta.1\nPRERELEASE=true\n');
  fs.writeFileSync(file, JSON.stringify({ version: 'invalid\nPRERELEASE=false' }));
  const failed = spawnSync(process.execPath, [cli, file], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.notEqual(failed.status, 0);
  assert.equal(fs.readFileSync(output, 'utf8'), 'VERSION=0.3.4-beta.1\nPRERELEASE=true\n');
});
