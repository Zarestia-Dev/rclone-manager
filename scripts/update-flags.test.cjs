const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  normalizeFlagName,
  parseFlags,
  parseStaticFlags,
  getStaticFlags,
  updateFile,
} = require('./update-flags.cjs');

test('flag names match the UI translation keys for camelCase, kebab-case and snake_case', () => {
  for (const [input, expected] of [
    ['createEmptySrcDirs', 'create_empty_src_dirs'],
    ['allow-other', 'allow_other'],
    ['vfs_cache_mode', 'vfs_cache_mode'],
    ['backupDir1', 'backup_dir1'],
    ['mountType', 'mount_type'],
    ['', ''],
  ]) {
    assert.equal(normalizeFlagName(input), expected);
  }
});

test('options/info parsing normalizes keys and preserves help including newlines and quotes', () => {
  const help = 'Do not change "source:path".\nKeep apostrophes: don’t.';
  assert.deepEqual(parseFlags(JSON.stringify({ main: [{ Name: 'dryRun', Help: help }] })), {
    dry_run: { title: 'Dry Run', help },
  });
});

test('options/info parsing rejects malformed JSON and invalid root values', () => {
  for (const input of ['{broken', 'null', '[]', '"text"', '42']) {
    assert.equal(parseFlags(input), null);
  }
});

test('options/info parsing skips malformed entries and supplies missing help', () => {
  assert.deepEqual(
    parseFlags(
      JSON.stringify({
        invalidBlock: null,
        main: [null, {}, { Name: '' }, { Name: ' ' }, { Name: 7 }, { Name: 'timeout' }],
      })
    ),
    { timeout: { title: 'Timeout', help: '' } }
  );
});

function completeFlagSchema() {
  return Object.fromEntries(
    ['main', 'filter', 'log', 'rc', 'vfs'].map(block => [
      block,
      [{ Name: `${block}_option`, Help: `${block} help` }],
    ])
  );
}

test('prune requires the complete global schema and rejects malformed option blocks', () => {
  const valid = completeFlagSchema();
  assert.ok(parseFlags(JSON.stringify(valid), true));
  for (const invalid of [
    {},
    { main: valid.main },
    { ...valid, vfs: [] },
    { ...valid, mount: null },
    { ...valid, mount: [{ Name: '' }] },
  ]) {
    assert.equal(parseFlags(JSON.stringify(invalid), true), null);
  }
});

test('static parsing handles nested examples, mixed quotes, escapes, and multiline text', () => {
  const source = `
    const unrelated = { Name: 'ignoreMe', Help: 'Not a static flag' };
    export const staticFlagDefinitions = {
      check: [{
        Name: 'oneWay',
        Help: "Find files which don't exist on destination.",
        Examples: [{ Value: 'true', Help: 'Example, not a flag' }],
      }],
      archive: [{
        Name: 'fullPath',
        Help: 'Keep \\'quoted\\' paths\\nwith \\t whitespace',
      }],
      bisync: [{ Name: 'resyncMode', Help: \`Line one\nLine two\`, Examples: [] }],
    };
  `;
  assert.deepEqual(parseStaticFlags(source), {
    one_way: { title: 'One Way', help: "Find files which don't exist on destination." },
    full_path: { title: 'Full Path', help: "Keep 'quoted' paths\nwith \t whitespace" },
    resync_mode: { title: 'Resync Mode', help: 'Line one\nLine two' },
  });
});

test('shared static flag names retain the first definition instead of overwriting help', () => {
  const flags = parseStaticFlags(`const staticFlagDefinitions = {
    move: [{ Name: 'createEmptySrcDirs', Help: 'Move help' }],
    sync: [{ Name: 'createEmptySrcDirs', Help: 'Sync help' }],
  };`);
  assert.deepEqual(flags.create_empty_src_dirs, {
    title: 'Create Empty Src Dirs',
    help: 'Move help',
  });
  assert.equal(Object.keys(flags).length, 1);
});

test('static parsing ignores empty names and non-literal definitions', () => {
  assert.deepEqual(
    parseStaticFlags(`const staticFlagDefinitions = {
      check: [{ Name: '', Help: 'Empty' }, { Name: 'missingHelp' },
        { Name: 'dynamicHelp', Help: getHelp() }, { Value: 'x', Help: 'Example' }],
    };`),
    {}
  );
  assert.deepEqual(parseStaticFlags(''), {});
});

test('actual static flags with nested examples and apostrophes are extracted', () => {
  const flags = getStaticFlags();
  for (const key of [
    'resync_mode',
    'check_sync',
    'conflict_loser',
    'conflict_resolve',
    'mount_type',
  ]) {
    assert.ok(flags[key], key);
  }
  assert.ok(flags.one_way.help.includes("don't"));
  assert.ok(flags.conflict_suffix.help.endsWith("(default: 'conflict')"));
  assert.ok(Object.keys(flags).every(key => key === normalizeFlagName(key)));
  assert.deepEqual(getStaticFlags(true), flags);
});

test('prune rejects partial static parsing instead of deleting unparsed definitions', () => {
  for (const source of [
    "const staticFlagDefinitions = { check: [{ Name: 'oneWay', Help: getHelp() }] };",
    "const staticFlagDefinitions = { check: [{ 'Name': getName(), Help: 'Help' }] };",
    "const staticFlagDefinitions = { check: [{ Name: 'oneWay', Help: 'Help' }], ...other };",
    "const staticFlagDefinitions = { check: [{ Name: 'oneWay', Help: 'Help' }, ...other] };",
    "const staticFlagDefinitions = { check: [{ Name: 'oneWay', Help: 'Help' }], copy: other };",
    "const staticFlagDefinitions = { check: [{ Name: 'oneWay', Help: 'Help' }]",
  ]) {
    assert.equal(parseStaticFlags(source, true), null, source);
  }
});

function fixture(t, tree) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-flags-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'rclone.json');
  fs.writeFileSync(file, JSON.stringify(tree, null, 2) + '\n');
  return file;
}

test('sync preserves translations, marks only new non-English entries and is idempotent', t => {
  const translated = { title: 'Deneme', help: 'Değişiklik yapmadan dene.' };
  const file = fixture(t, { dry_run: translated });
  const flags = {
    dry_run: { title: 'Dry Run', help: 'Trial run' },
    new_flag: { title: 'New Flag', help: 'Help with "quotes"\nNew line' },
  };
  updateFile(file, flags);
  const synced = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(synced), {
    dry_run: translated,
    new_flag: { TODO: 'NEEDS_TRANSLATION', ...flags.new_flag },
  });
  updateFile(file, flags);
  assert.equal(fs.readFileSync(file, 'utf8'), synced);
});

test('English sync adds entries without translation markers', t => {
  const file = fixture(t, {});
  const flags = { test: { title: 'Test', help: 'Test help' } };
  updateFile(file, flags, false, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), flags);
});

test('prune keeps runtime mount and serve choices and removes obsolete flags', t => {
  const choice = { title: 'Choice', help: 'Help' };
  const file = fixture(t, {
    mount_type_saf: choice,
    serve_type_sftp: choice,
    obsolete: choice,
  });
  updateFile(file, {}, true, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    mount_type_saf: choice,
    serve_type_sftp: choice,
  });
});

test('default sync retains older flags for compatibility', t => {
  const tree = { older_flag: { title: 'Older flag', help: 'Keep translation' } };
  const file = fixture(t, tree);
  updateFile(file, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), tree);
});

test('dry run leaves bytes unchanged when sync would add and prune entries', t => {
  const file = fixture(t, { obsolete: { title: 'Eski', help: 'Eski açıklama' } });
  const before = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  updateFile(file, { added: { title: 'Added', help: 'New help' } }, true, false, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('invalid JSON files are left untouched', t => {
  const file = fixture(t, {});
  fs.writeFileSync(file, '{broken');
  updateFile(file, { test: { title: 'Test', help: 'Help' } });
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('failed fetch with --prune exits unsuccessfully without modifying translations', t => {
  // An empty PATH makes rclone unavailable without depending on a running RC server.
  const directory = path.dirname(fixture(t, {}));
  const script = path.join(directory, 'scripts/update-flags.cjs');
  const definitions = path.join(directory, 'src/app/services/remote/flag-definitions.ts');
  const locale = path.join(directory, 'resources/i18n/en-US/rclone.json');
  for (const file of [script, definitions, locale]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.copyFileSync(path.join(__dirname, 'update-flags.cjs'), script);
  fs.writeFileSync(
    definitions,
    "const staticFlagDefinitions = { check: [{ Name: 'oneWay', Help: 'One way' }] };"
  );
  fs.writeFileSync(locale, JSON.stringify({ keep: { title: 'Keep', help: 'Keep translation' } }));
  const before = fs.readFileSync(locale, 'utf8');
  const result = spawnSync(process.execPath, [script, '--prune'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: directory, NODE_PATH: path.resolve(__dirname, '../node_modules') },
    cwd: directory,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Translation files were not changed/);
  assert.equal(fs.readFileSync(locale, 'utf8'), before);
});
