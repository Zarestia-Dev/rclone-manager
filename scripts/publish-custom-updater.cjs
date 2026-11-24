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
  // Filter inside gh: full release histories include large bodies and asset lists.
  const releases = gh([
    'api',
    'repos/{owner}/{repo}/releases?per_page=100',
    '--paginate',
    '--jq',
    `.[] | select(.tag_name == ${JSON.stringify(tag)}) | {tag_name, draft}`,
  ])
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));
  if (releases.some(release => release?.tag_name !== tag || typeof release.draft !== 'boolean'))
    throw new Error('Invalid release list');
  if (releases.some(release => !release.draft))
    throw new Error('Refusing to change a published release');
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

const manifests = catalog =>
  Object.values(catalog.entries).map(entry =>
    JSON.parse(Buffer.from(entry.manifest, 'base64').toString('utf8'))
  );

// Installs of the RClone Manager Headless app (Tauri, 0.3.6 and older) update from
// `latest.json`. It sends them to the server package of their own format, with the
// signatures of the catalog.
function tauriUpdateJson(catalog, tag, repository) {
  const platforms = {};
  // Tauri names the installer formats as the catalog does.
  for (const manifest of manifests(catalog))
    if (['deb', 'rpm', 'nsis', 'msi'].includes(manifest.kind))
      platforms[`${manifest.target}-${manifest.kind}`] = {
        signature: manifest.signature,
        url: `https://github.com/${repository}/releases/download/${tag}/${manifest.asset}`,
      };
  if (!Object.keys(platforms).length) return null;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  return { version: catalog.version, pub_date: new Date().toISOString(), platforms };
}

// Clients download each entry's file from this release by its name: one that is
// missing would leave every installation that needs it without its update.
function checkAssets(catalog, tag, assets) {
  for (const { asset } of manifests(catalog))
    if (!assets.some(file => file.name === asset))
      throw new Error(`${tag} has no ${asset}; upload it before the catalog`);
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
  checkAssets(merged, tag, release.assets);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rcman-catalog-'));
  try {
    const file = path.join(temporary, MANIFEST_NAME);
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
    const files = [file];
    const tauri = tauriUpdateJson(merged, tag, process.env.GH_REPO);
    if (tauri) {
      files.push(path.join(temporary, 'latest.json'));
      fs.writeFileSync(files[1], `${JSON.stringify(tauri, null, 2)}\n`);
    }
    gh(['release', 'upload', tag, ...files, '--clobber']);
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
module.exports = { checkRelease, publishCatalog, readCatalogs, tauriUpdateJson };
