/* Call only from a serialized release upload job (see workflow concurrency groups). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mergeCatalogs, MANIFEST_NAME } = require('./create-update-manifest.cjs');
const runGh = args => execFileSync('gh', args, { encoding: 'utf8' });

function validateTag(tag, version) {
  if (![`v${version}`, `headless-v${version}`].includes(tag))
    throw new Error('Unexpected release tag');
}

// A missing release is allowed: the following upload step creates it as a draft.
function checkRelease(tag, version, gh = runGh) {
  validateTag(tag, version);
  const pages = JSON.parse(
    gh(['api', 'repos/{owner}/{repo}/releases?per_page=100', '--paginate', '--slurp'])
  );
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page)))
    throw new Error('Invalid release list');
  const release = pages.flat().find(release => release.tag_name === tag);
  if (release && release.draft !== true) throw new Error('Refusing to change a published release');
}

function readCatalogs(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return readCatalogs(file);
    return entry.isFile() && entry.name === MANIFEST_NAME
      ? [JSON.parse(fs.readFileSync(file, 'utf8'))]
      : [];
  });
}

function publishCatalog(tag, version, directory, gh = runGh) {
  validateTag(tag, version);
  const catalogs = readCatalogs(directory);
  if (!catalogs.length) throw new Error('No custom update catalogs found');
  // Validate local fragments before making any release changes.
  mergeCatalogs(version, catalogs);
  const release = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft,assets']));
  if (release.isDraft !== true) throw new Error('Refusing to change a published release');
  if (release.assets.some(asset => asset.name === MANIFEST_NAME)) {
    const existing = JSON.parse(
      gh(['release', 'download', tag, '--pattern', MANIFEST_NAME, '--output', '-'])
    );
    catalogs.unshift(existing);
  }
  const merged = mergeCatalogs(version, catalogs);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rcman-catalog-'));
  try {
    const file = path.join(temporary, MANIFEST_NAME);
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
    gh(['release', 'upload', tag, file, '--clobber']);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return merged;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3)
      throw new Error(
        'Usage: publish-custom-updater tag version artifacts-directory | --check tag version'
      );
    if (args[0] === '--check') checkRelease(args[1], args[2]);
    else publishCatalog(...args);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { checkRelease, publishCatalog, readCatalogs };
