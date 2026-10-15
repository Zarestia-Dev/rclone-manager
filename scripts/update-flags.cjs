const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ts = require('typescript');

// Configuration
const DEFAULT_RCLONE_URL = 'http://127.0.0.1:5572';
const PROJECT_ROOT = path.dirname(__dirname);
const I18N_DIR = path.join(PROJECT_ROOT, 'resources', 'i18n');

/**
 * Fetch flags from rclone rc options/info.
 */
function getFlags(url, loopback = false) {
  console.log(`Fetching flags from ${loopback ? 'local rclone (--loopback)' : url}...`);
  try {
    const connectionArgs = loopback ? ['--loopback'] : ['--rc-no-auth', '--url', url];
    const result = spawnSync('rclone', ['rc', 'options/info', ...connectionArgs], {
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      console.error(`Error calling rclone: ${result.error?.message || result.stderr}`);
      console.log("Start 'rclone rcd --rc-no-auth --rc-addr 127.0.0.1:5572', or use --loopback.");
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
    return null;
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.error('Invalid options/info response: expected an object of option blocks.');
    return null;
  }

  const flags = {};
  for (const options of Object.values(data)) {
    if (!Array.isArray(options)) continue;

    for (const option of options) {
      if (!option || typeof option.Name !== 'string' || !option.Name.trim()) continue;
      const flagName = option.Name;
      const helpText = typeof option.Help === 'string' ? option.Help : '';

      const key = normalizeFlagName(flagName);
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
function normalizeFlagName(s) {
  // Match RcloneOptionTranslatePipe so static camelCase flags use existing translations.
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

function titleCase(s) {
  return normalizeFlagName(s)
    .split('_')
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
      currentData[key] = isEnglish ? val : { TODO: 'NEEDS_TRANSLATION', ...val };
      addedCount++;
    }
  }

  // Check for unused/orphaned keys
  // Runtime mount/serve choices are synthesized by FlagConfigService, not options/info.
  const unusedKeys = Object.keys(currentData).filter(
    key => !(key in flagsData) && !key.startsWith('mount_type_') && !key.startsWith('serve_type_')
  );
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
  const filePath = path.join(
    PROJECT_ROOT,
    'src',
    'app',
    'services',
    'remote',
    'flag-definitions.ts'
  );
  if (!fs.existsSync(filePath)) {
    console.warn(`Static flag definitions not found at ${filePath}`);
    return {};
  }
  return parseStaticFlags(fs.readFileSync(filePath, 'utf8'));
}

function parseStaticFlags(content) {
  const source = ts.createSourceFile('flag-definitions.ts', content, ts.ScriptTarget.Latest, true);
  const staticFlags = {};

  function visitOption(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const fields = {};
      for (const property of node.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
          ts.isStringLiteralLike(property.initializer)
        ) {
          fields[property.name.text] = property.initializer.text;
        }
      }
      if (fields.Name?.trim() && typeof fields.Help === 'string') {
        const key = normalizeFlagName(fields.Name);
        // Shared flag names may have operation-specific help; keep the first definition.
        staticFlags[key] ??= { title: titleCase(fields.Name), help: fields.Help };
      }
    }
    ts.forEachChild(node, visitOption);
  }

  function visitDeclaration(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'staticFlagDefinitions' &&
      node.initializer
    ) {
      visitOption(node.initializer);
      return;
    }
    ts.forEachChild(node, visitDeclaration);
  }

  visitDeclaration(source);
  return staticFlags;
}

/**
 * Main function.
 */
function main() {
  const args = process.argv.slice(2);
  let url = DEFAULT_RCLONE_URL;
  const prune = args.includes('--prune');
  const loopback = args.includes('--loopback');

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[i + 1];
      break;
    }
  }

  const flags = getFlags(url, loopback);
  if (!flags || Object.keys(flags).length === 0) {
    console.error('Could not fetch rclone flags. Translation files were not changed.');
    process.exitCode = 1;
    return;
  }

  const staticFlags = getStaticFlags();
  if (Object.keys(staticFlags).length === 0) {
    console.error('Could not load static flag definitions. Translation files were not changed.');
    process.exitCode = 1;
    return;
  }
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

module.exports = { normalizeFlagName, parseFlags, parseStaticFlags, getStaticFlags, updateFile };
