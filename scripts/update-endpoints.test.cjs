const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readRcConsoleLists, findRcConsoleDrift } = require('./update-endpoints.cjs');

const lists = {
  readOnly: ['core/version'],
  dangerous: ['core/quit'],
  required: { 'operations/list': ['fs', 'remote'] },
};
const commands = [
  { Path: 'core/version', Help: '' },
  { Path: 'core/quit', Help: '' },
  { Path: 'operations/list', Help: '- fs - a remote name\n- remote - a path\n- opt - options' },
];

test('the console lists in the source are found', () => {
  const found = readRcConsoleLists();
  assert.ok(found.readOnly.includes('core/version'));
  assert.ok(found.dangerous.includes('job/batch'));
  assert.deepEqual(found.required['operations/copyfile'], [
    'srcFs',
    'srcRemote',
    'dstFs',
    'dstRemote',
  ]);
});

test('lists that match rclone report nothing', () => {
  assert.deepEqual(findRcConsoleDrift(commands, [], lists), []);
});

test('a call that rclone no longer has is reported', () => {
  const problems = findRcConsoleDrift(commands.slice(1), [], lists);
  assert.deepEqual(problems, ['READ_ONLY_COMMANDS: core/version is not in this rclone']);
});

test('a required parameter missing from the help is reported', () => {
  const renamed = commands.map(c =>
    c.Path === 'operations/list' ? { ...c, Help: '- fs - a remote name' } : c
  );
  assert.deepEqual(findRcConsoleDrift(renamed, [], lists), [
    'REQUIRED_PARAMS: operations/list does not list "remote" in its help',
  ]);
});

test('new calls are listed for review', () => {
  const problems = findRcConsoleDrift(commands, ['sync/newcall'], lists);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /new call sync\/newcall/);
});
