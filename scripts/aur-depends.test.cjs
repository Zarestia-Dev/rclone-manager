/* The AUR packages repackage the release's Arch package, but makepkg builds its own metadata from
 * the PKGBUILD, so dependencies live in two places. They must not drift apart. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// `name=('a' 'b'\n 'c')` in a PKGBUILD.
function pkgbuildArray(text, name) {
  const match = new RegExp(`^${name}=\\(([\\s\\S]*?)\\)`, 'm').exec(text);
  assert.ok(match, `PKGBUILD has no ${name}`);
  return [...match[1].matchAll(/'([^']*)'/g)].map(item => item[1]);
}

// The list `key:` of `overrides: archlinux:` in an nfpm file, as written there.
function nfpmArchList(text, key) {
  const lines = text.split('\n');
  const indentOf = line => line.length - line.trimStart().length;
  const overrides = lines.findIndex(line => /^overrides:\s*$/.test(line));
  assert.ok(overrides >= 0, 'nfpm file has no overrides');
  const arch = lines.findIndex((line, i) => i > overrides && /^ {2}archlinux:\s*$/.test(line));
  assert.ok(arch >= 0, 'nfpm file has no overrides.archlinux');
  const start = lines.findIndex(
    (line, i) => i > arch && new RegExp(`^ {4}${key}:\\s*$`).test(line)
  );
  assert.ok(start >= 0, `overrides.archlinux has no ${key}`);
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && indentOf(line) <= 4) break;
    const item = /^\s*-\s+(.*?)\s*$/.exec(line);
    if (item) items.push(item[1].replace(/^(["'])(.*)\1$/, '$2'));
  }
  return items;
}

for (const [name, pkgbuild, nfpm] of [
  ['desktop', 'backend/desktop/linux/AUR/PKGBUILD', 'backend/desktop/linux/nfpm.yaml'],
  ['server', 'backend/desktop/linux/AUR/PKGBUILD-server', 'backend/server/package/nfpm.yaml'],
]) {
  test(`the ${name} AUR package and its Arch package depend on the same packages`, () => {
    const aur = read(pkgbuild);
    const arch = read(nfpm);
    const sorted = list => [...list].sort();
    assert.deepEqual(sorted(pkgbuildArray(aur, 'depends')), sorted(nfpmArchList(arch, 'depends')));
    // pacman calls recommended packages optional dependencies.
    assert.deepEqual(
      sorted(pkgbuildArray(aur, 'optdepends')),
      sorted(nfpmArchList(arch, 'recommends'))
    );
  });
}
