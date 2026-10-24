// Shared release classification and Android numbering for local and CI builds.
const fs = require('node:fs');
const path = require('node:path');

function parseVersion(version) {
  const match =
    typeof version === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version
    );
  if (!match) throw new Error(`Invalid release version: ${version}`);
  const core = match.slice(1, 4).map(Number);
  if (!core.every(Number.isSafeInteger) || match[4]?.split('.').some(part => /^0\d+$/.test(part))) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return { core, prerelease: match[4] ?? null };
}

function androidVersionCode(version) {
  const {
    core: [major, minor, patch],
    prerelease,
  } = parseVersion(version);
  if (minor > 99 || patch > 99)
    throw new Error('Android minor and patch versions must be between 0 and 99');
  let suffix = 999;
  if (prerelease !== null) {
    const match = /^(alpha|beta|dev|preview|rc)(?:\.(0|[1-9]\d*))?$/.exec(prerelease);
    if (!match || (match[2] !== undefined && Number(match[2]) > 197)) {
      throw new Error(
        'Android prereleases must use alpha, beta, dev, preview or rc, optionally followed by .0 through .197'
      );
    }
    // Follow the same lexical label order as SemVer and the Rust comparator.
    const stage = ['alpha', 'beta', 'dev', 'preview', 'rc'].indexOf(match[1]);
    suffix = stage * 200 + (match[2] === undefined ? 0 : Number(match[2]) + 1);
  }
  const code = ((major * 100 + minor) * 100 + patch) * 1000 + suffix;
  if (!Number.isSafeInteger(code) || code < 1 || code > 2100000000) {
    throw new Error('Android versionCode must be between 1 and 2100000000');
  }
  return code;
}

function androidBuildArgs(args, appDirectory) {
  if (args[0] !== 'android' || !['build', 'dev'].includes(args[1])) return args;
  let config = JSON.parse(fs.readFileSync(path.join(appDirectory, 'tauri.conf.json'), 'utf8'));
  const android = path.join(appDirectory, 'tauri.android.conf.json');
  if (fs.existsSync(android))
    config = { ...config, ...JSON.parse(fs.readFileSync(android, 'utf8')) };
  const separator = args.indexOf('--');
  const end = separator === -1 ? args.length : separator;
  for (let index = 2; index < end; index++) {
    let value;
    if (args[index] === '--config' || args[index] === '-c') value = args[++index];
    else if (args[index].startsWith('--config=')) value = args[index].slice('--config='.length);
    if (value !== undefined) {
      const text = value.trim().startsWith('{')
        ? value
        : fs.readFileSync(path.resolve(value), 'utf8');
      config = { ...config, ...JSON.parse(text) };
    }
  }
  const override = JSON.stringify({
    bundle: {
      android: { versionCode: androidVersionCode(config.version), autoIncrementVersionCode: false },
    },
  });
  return [...args.slice(0, end), '--config', override, ...args.slice(end)];
}

function releaseMetadata(configFile) {
  const { version } = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  return { VERSION: version, PRERELEASE: String(parseVersion(version).prerelease !== null) };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: release-version <tauri-config.json>');
    const output = Object.entries(releaseMetadata(process.argv[2]))
      .map(([key, value]) => `${key}=${value}\n`)
      .join('');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
    else process.stdout.write(output);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { parseVersion, androidVersionCode, androidBuildArgs, releaseMetadata };
