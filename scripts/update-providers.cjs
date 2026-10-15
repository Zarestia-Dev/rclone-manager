const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Configuration
const DEFAULT_RCLONE_URL = 'http://127.0.0.1:5572';
const PROJECT_ROOT = path.dirname(__dirname);
const I18N_DIR = path.join(PROJECT_ROOT, 'resources', 'i18n');

/**
 * Fetch providers from rclone rc.
 */
function getProviders(url, loopback = false, prune = false) {
  console.log(`Fetching providers from ${loopback ? 'local rclone (--loopback)' : url}...`);
  try {
    const connectionArgs = loopback ? ['--loopback'] : ['--rc-no-auth', '--url', url];
    const result = spawnSync('rclone', ['rc', 'config/providers', ...connectionArgs], {
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      console.error(`Error calling rclone: ${result.error?.message || result.stderr}`);
      console.log(
        "Ensure rclone is running with 'rclone rcd --rc-no-auth --rc-addr :5572' or similar."
      );
      return null;
    }

    return parseProviders(result.stdout, prune);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error('rclone command not found. Please verify it is installed and in your PATH.');
    } else {
      console.error(`Unexpected error: ${e.message}`);
    }
    return null;
  }
}

function isValidProviderSchema(data, prune = false) {
  if (!data || !Array.isArray(data.providers) || data.providers.length === 0) return false;
  const names = new Set();
  for (const provider of data.providers) {
    if (
      !provider ||
      typeof provider.Name !== 'string' ||
      !provider.Name.trim() ||
      names.has(provider.Name) ||
      !Array.isArray(provider.Options) ||
      (prune && provider.Options.length === 0)
    ) {
      return false;
    }
    names.add(provider.Name);
    // A provider may repeat an option for different conditional configuration steps.
    for (const option of provider.Options) {
      if (!option || typeof option.Name !== 'string' || !option.Name.trim()) {
        return false;
      }
    }
  }
  // Standard builds include these providers on every supported platform.
  return !prune || ['local', 'memory', 's3'].every(name => names.has(name));
}

function parseProviders(output, prune = false) {
  try {
    const data = JSON.parse(output);
    if (isValidProviderSchema(data, prune)) return data;
    console.error(
      'Invalid or incomplete config/providers schema. Translation files were not changed.'
    );
  } catch (e) {
    console.error(`Error decoding config/providers response: ${e.message}`);
  }
  return null;
}

/**
 * Simple title case helper.
 */
function titleCase(s) {
  return s
    .replace(/_/g, ' ')
    .replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}

/**
 * Updates a single rclone-providers.json file.
 */
function updateFile(filePath, providersData, prune = false, isEnglish = false, dryRun = false) {
  console.log(`Checking ${filePath}...`);

  if (!isValidProviderSchema(providersData, prune)) {
    console.error(
      'Invalid or incomplete config/providers schema. Translation files were not changed.'
    );
    return;
  }

  let currentData;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    currentData = JSON.parse(content);
  } catch (e) {
    console.warn(`  Skipping invalid or missing file: ${filePath}`);
    return;
  }

  if (!currentData.providers) {
    console.warn(`  No 'providers' key in ${filePath}`);
    return;
  }

  const fetchedProviders = providersData.providers;
  const providerMap = Object.fromEntries(fetchedProviders.map(p => [p.Name, p]));

  let addedCount = 0;
  let removedCount = 0;

  // 1. Add missing providers and options
  for (const [pName, pDef] of Object.entries(providerMap)) {
    if (!currentData.providers[pName]) {
      currentData.providers[pName] = {};
      addedCount++;
    }

    const fetchedOptions = pDef.Options || [];
    for (const opt of fetchedOptions) {
      if (opt.Name && !currentData.providers[pName][opt.Name]) {
        const val = {
          title: titleCase(opt.Name),
          help: opt.Help || '',
        };

        currentData.providers[pName][opt.Name] = isEnglish
          ? val
          : { TODO: 'NEEDS_TRANSLATION', ...val };
        addedCount++;
      }
    }
  }

  // 2. Handle unused providers and options
  const unusedProviders = Object.keys(currentData.providers).filter(
    pName => !(pName in providerMap)
  );
  if (unusedProviders.length > 0) {
    if (prune) {
      for (const pName of unusedProviders) {
        delete currentData.providers[pName];
        removedCount++;
      }
    } else {
      console.warn(
        `  [WARN] Found ${unusedProviders.length} providers absent from this schema (use --prune to remove)`
      );
    }
    console.log(`  Providers absent from this schema: ${unusedProviders.join(', ')}`);
  }

  for (const [pName, options] of Object.entries(currentData.providers)) {
    if (!providerMap[pName]) continue;
    const validOptionNames = new Set((providerMap[pName].Options || []).map(o => o.Name));
    const unusedOptions = Object.keys(options).filter(optName => !validOptionNames.has(optName));

    if (unusedOptions.length > 0) {
      if (prune) {
        for (const optName of unusedOptions) {
          delete currentData.providers[pName][optName];
          removedCount++;
        }
      } else {
        console.warn(
          `  [WARN] Provider '${pName}' has ${unusedOptions.length} options absent from this schema (use --prune to remove)`
        );
      }
      console.log(`  Options absent from this schema (${pName}): ${unusedOptions.join(', ')}`);
    }
  }

  if (addedCount > 0 || removedCount > 0) {
    if (dryRun) {
      console.log(`  [DRY RUN] Would update ${filePath} (+${addedCount}, -${removedCount})`);
      return;
    }
    fs.writeFileSync(filePath, JSON.stringify(currentData, null, 2) + '\n', 'utf8');
    console.log(`  Updated ${filePath} (+${addedCount}, -${removedCount})`);
  } else {
    console.log(`  No changes for ${filePath}`);
  }
}

/**
 * Main function.
 */
function main() {
  const args = process.argv.slice(2);
  let url = DEFAULT_RCLONE_URL;
  const prune = args.includes('--prune');
  const loopback = args.includes('--loopback');
  const dryRun = args.includes('--dry-run');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[i + 1];
      break;
    }
  }

  const providers = getProviders(url, loopback, prune);
  if (!providers) process.exit(1);

  if (!fs.existsSync(I18N_DIR)) {
    console.error(`i18n directory not found at ${I18N_DIR}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(I18N_DIR);
  for (const entry of entries) {
    const langDir = path.join(I18N_DIR, entry);
    if (fs.statSync(langDir).isDirectory()) {
      const targetFile = path.join(langDir, 'rclone-providers.json');
      if (fs.existsSync(targetFile)) {
        console.log(`Processing language: ${entry}`);
        updateFile(targetFile, providers, prune, entry === 'en-US', dryRun);
      }
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { isValidProviderSchema, parseProviders, updateFile };
