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
function getProviders(url) {
  console.log(`Fetching providers from ${url}...`);
  try {
    const result = spawnSync('rclone', ['rc', 'config/providers', '--rc-no-auth', '--url', url], {
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      console.error(`Error calling rclone: ${result.stderr}`);
      console.log(
        "Ensure rclone is running with 'rclone rcd --rc-no-auth --rc-addr :5572' or similar."
      );
      return null;
    }

    return JSON.parse(result.stdout);
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error('rclone command not found. Please verify it is installed and in your PATH.');
    } else {
      console.error(`Unexpected error: ${e.message}`);
    }
    return null;
  }
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
function updateFile(filePath, providersData, prune = false, isEnglish = false) {
  console.log(`Checking ${filePath}...`);

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

  const fetchedProviders = providersData.providers || [];
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
  const unusedProviders = Object.keys(currentData.providers).filter(pName => !(pName in providerMap));
  if (unusedProviders.length > 0) {
    if (prune) {
      for (const pName of unusedProviders) {
        delete currentData.providers[pName];
        removedCount++;
      }
    } else {
      console.warn(`  [WARN] Found ${unusedProviders.length} unused providers (use --prune to remove)`);
    }
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
        console.warn(`  [WARN] Provider '${pName}' has ${unusedOptions.length} unused options (use --prune to remove)`);
      }
    }
  }

  if (addedCount > 0 || removedCount > 0) {
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[i + 1];
      break;
    }
  }

  const providers = getProviders(url);
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
        updateFile(targetFile, providers, prune, entry === 'en-US');
      }
    }
  }
}

if (require.main === module) {
  main();
}
