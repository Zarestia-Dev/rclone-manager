const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isValidProviderSchema, parseProviders, updateFile } = require('./update-providers.cjs');

function schema() {
  return {
    providers: ['local', 'memory', 's3'].map(Name => ({
      Name,
      Options: [{ Name: 'description', Help: 'Remote description.' }],
    })),
  };
}

function fixture(t, tree) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-providers-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'rclone-providers.json');
  fs.writeFileSync(file, JSON.stringify(tree, null, 2) + '\n');
  return file;
}

test('provider parsing rejects empty, malformed and missing schemas', () => {
  for (const input of ['{broken', 'null', '{}', '[]', '{"providers":[]}', '{"providers":{}}']) {
    assert.equal(parseProviders(input), null);
  }
});

test('prune rejects partial provider schemas and missing option arrays', () => {
  const valid = schema();
  assert.deepEqual(parseProviders(JSON.stringify(valid), true), valid);
  assert.equal(isValidProviderSchema({ providers: [valid.providers[0]] }, true), false);
  assert.equal(isValidProviderSchema({ providers: [{ Name: 'local' }] }), false);
  const emptyOptions = schema();
  emptyOptions.providers[0].Options = [];
  assert.equal(isValidProviderSchema(emptyOptions, true), false);
});

test('schema validation rejects invalid names and duplicate providers', () => {
  for (const provider of [null, { Name: '' }, { Name: 1 }, { Name: 'local', Options: [null] }]) {
    assert.equal(isValidProviderSchema({ providers: [provider] }), false);
  }
  const valid = schema();
  assert.equal(
    isValidProviderSchema({ providers: [...valid.providers, valid.providers[0]] }),
    false
  );
});

test('conditional repeated option names are valid, as used by the Koofr provider', () => {
  const data = schema();
  data.providers[0].Options.push(data.providers[0].Options[0]);
  assert.equal(isValidProviderSchema(data, true), true);
});

test('invalid schema cannot erase a translated provider even with prune enabled', t => {
  const tree = { providers: { local: { description: { title: 'Açıklama', help: 'Açıklama.' } } } };
  const file = fixture(t, tree);
  const before = fs.readFileSync(file, 'utf8');
  for (const invalid of [{}, { providers: [] }, { providers: [{ Name: 'local' }] }]) {
    updateFile(file, invalid, true);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('prune removes absent options and providers while preserving existing translations', t => {
  const translated = { title: 'Açıklama', help: 'Uzak bağlantının açıklaması.' };
  const current = {
    providers: Object.fromEntries(
      ['local', 'memory', 's3', 'obsolete'].map(name => [name, { description: translated }])
    ),
  };
  current.providers.local.old_option = { title: 'Eski', help: 'Eski seçenek' };
  const file = fixture(t, current);
  updateFile(file, schema(), true);
  const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(updated.providers), ['local', 'memory', 's3']);
  assert.deepEqual(updated.providers.local, { description: translated });
});

test('dry run reports additions and removals without writing the translation file', t => {
  const tree = { providers: { obsolete: { name: { title: 'Old', help: 'Old help' } } } };
  const file = fixture(t, tree);
  const before = fs.readFileSync(file, 'utf8');
  const mtime = fs.statSync(file).mtimeMs;
  updateFile(file, schema(), true, false, true);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
});

test('default sync retains absent providers and options and is idempotent', t => {
  const tree = { providers: { obsolete: { name: { title: 'Old', help: 'Old help' } } } };
  const file = fixture(t, tree);
  updateFile(file, schema());
  const first = fs.readFileSync(file, 'utf8');
  const updated = JSON.parse(first);
  assert.deepEqual(updated.providers.obsolete, tree.providers.obsolete);
  assert.equal(updated.providers.local.description.TODO, 'NEEDS_TRANSLATION');
  updateFile(file, schema());
  assert.equal(fs.readFileSync(file, 'utf8'), first);
});

test('English provider sync adds entries without translation markers', t => {
  const file = fixture(t, { providers: {} });
  updateFile(file, schema(), false, true);
  const updated = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(updated.providers.local.description, {
    title: 'Description',
    help: 'Remote description.',
  });
});
