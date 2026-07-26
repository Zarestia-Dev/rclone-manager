const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Configuration
const DEFAULT_RCLONE_URL = 'http://127.0.0.1:5572';
const PROJECT_ROOT = path.dirname(__dirname);
const I18N_DIR = path.join(PROJECT_ROOT, 'resources', 'i18n');

/**
 * Fetch flags from rclone rc options/info.
 */
function getFlags(url) {
  console.log(`Fetching flags from ${url}...`);
  try {
    const result = spawnSync('rclone', ['rc', 'options/info', '--rc-no-auth', '--url', url], {
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      console.error(`Error calling rclone: ${result.stderr}`);
      console.log(
        "Ensure rclone is running with 'rclone rcd --rc-no-auth --rc-addr :5572' or similar."
      );
      return null;
    }

    return parseFlags(result.stdout);
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
 * Parses 'rclone rc options/info' output (JSON).
 */
function parseFlags(output) {
  let data;
  try {
    data = JSON.parse(output);
  } catch (e) {
    console.error(`Error decoding JSON response: ${e.message}`);
    return {};
  }

  const flags = {};
  for (const [blockName, options] of Object.entries(data)) {
    if (!Array.isArray(options)) continue;

    for (const option of options) {
      const flagName = option.Name;
      const helpText = option.Help || '';

      if (!flagName) continue;

      const key = flagName.replace(/-/g, '_');
      flags[key] = {
        title: titleCase(flagName),
        help: helpText,
      };
    }
  }
  return flags;
}

/**
 * Simple title case helper.
 */
function titleCase(s) {
  return s
    .split(/[-_]/)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Updates a single rclone.json file.
 */
function updateFile(filePath, flagsData, prune = false, isEnglish = false) {
  console.log(`Checking ${filePath}...`);

  let currentData;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    currentData = JSON.parse(content);
  } catch (e) {
    console.warn(`  Skipping invalid or missing file: ${filePath}`);
    return;
  }

  let addedCount = 0;
  let removedCount = 0;

  // Add missing keys
  for (const [key, val] of Object.entries(flagsData)) {
    if (!(key in currentData)) {
      currentData[key] = isEnglish
        ? val
        : { TODO: 'NEEDS_TRANSLATION', ...val };
      addedCount++;
    }
  }

  // Check for unused/orphaned keys
  const unusedKeys = Object.keys(currentData).filter(key => !(key in flagsData));
  if (unusedKeys.length > 0) {
    if (prune) {
      for (const key of unusedKeys) {
        delete currentData[key];
        removedCount++;
      }
      console.log(`  [PRUNE] Removed ${removedCount} unused keys`);
    } else {
      console.warn(`  [WARN] Found ${unusedKeys.length} unused keys (use --prune to remove)`);
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
 * Extract static flag definitions from flag-definitions.ts.
 */
function getStaticFlags() {
  const filePath = path.join(PROJECT_ROOT, 'src', 'app', 'services', 'remote', 'flag-definitions.ts');
  if (!fs.existsSync(filePath)) {
    console.warn(`Static flag definitions not found at ${filePath}`);
    return {};
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const staticFlags = {};
  const objectBlocks = content.match(/\{[^{}]*Name:[^{}]*\}/g) || [];

  for (const block of objectBlocks) {
    const nameMatch = block.match(/Name:\s*['"]([^'"]+)['"]/);
    const helpMatch = block.match(/Help:\s*['"]([\s\S]*?)['"]\s*,/);
    if (nameMatch && helpMatch) {
      const flagName = nameMatch[1];
      const helpText = helpMatch[1].trim().replace(/\r?\n/g, ' ').replace(/\s+/g, ' ');
      const key = flagName.replace(/-/g, '_');
      staticFlags[key] = {
        title: titleCase(flagName),
        help: helpText,
      };
    }
  }
  return staticFlags;
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

  let flags = getFlags(url);
  if (!flags) {
    console.warn('Could not fetch flags from running rclone. Using only static flag definitions.');
    flags = {};
  }

  const staticFlags = getStaticFlags();
  const mergedFlags = { ...flags, ...staticFlags };

  if (Object.keys(mergedFlags).length === 0) {
    console.error('No flags found to process.');
    process.exit(1);
  }

  if (!fs.existsSync(I18N_DIR)) {
    console.error(`i18n directory not found at ${I18N_DIR}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(I18N_DIR);
  for (const entry of entries) {
    const langDir = path.join(I18N_DIR, entry);
    if (fs.statSync(langDir).isDirectory()) {
      const targetFile = path.join(langDir, 'rclone.json');
      if (fs.existsSync(targetFile)) {
        console.log(`Processing language: ${entry}`);
        updateFile(targetFile, mergedFlags, prune, entry === 'en-US');
      }
    }
  }
}

if (require.main === module) {
  main();
}
