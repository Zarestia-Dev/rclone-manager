#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const i18nRoot = path.join(repoRoot, 'resources', 'i18n');
const unusedJsonPath = path.join(repoRoot, 'unused.json');

let auditData = null;

// 1. Try to read from unused.json if present, or run audit-i18n-keys.cjs --json directly
if (fs.existsSync(unusedJsonPath)) {
  try {
    const raw = fs.readFileSync(unusedJsonPath, 'utf8');
    const lines = raw.split('\n');
    const jsonStart = lines.findIndex(line => line.trim().startsWith('{'));
    if (jsonStart !== -1) {
      auditData = JSON.parse(lines.slice(jsonStart).join('\n'));
    }
  } catch (err) {
    console.warn(`Could not parse ${unusedJsonPath}: ${err.message}`);
  }
}

if (!auditData) {
  const auditScript = path.join(__dirname, 'audit-i18n-keys.cjs');
  const result = spawnSync('node', [auditScript, '--json'], {
    encoding: 'utf8',
    cwd: repoRoot,
  });

  if (result.status !== 0 && !result.stdout) {
    console.error(`Failed to run audit script: ${result.stderr}`);
    process.exit(1);
  }

  try {
    const stdout = result.stdout;
    const jsonStart = stdout.indexOf('{');
    if (jsonStart !== -1) {
      auditData = JSON.parse(stdout.slice(jsonStart));
    }
  } catch (err) {
    console.error(`Failed to parse audit JSON output: ${err.message}`);
    process.exit(1);
  }
}

if (!auditData || !auditData.locales) {
  console.log('No locale data found from audit.');
  process.exit(0);
}

// Function to remove keys from an object based on a flat key set
function removeKeys(obj, keysToRemove) {
  const keysSet = keysToRemove instanceof Set ? keysToRemove : new Set(keysToRemove);

  function traverse(current, prefix = '') {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return;
    }

    for (const key of Object.keys(current)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (keysSet.has(fullKey)) {
        delete current[key];
      } else if (
        typeof current[key] === 'object' &&
        current[key] !== null &&
        !Array.isArray(current[key])
      ) {
        traverse(current[key], fullKey);
      }
    }
  }

  traverse(obj);
  return obj;
}

// Function to recursively clean up empty objects after key removal
function cleanupEmptyObjects(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }

  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      cleanupEmptyObjects(obj[key]);
      if (Object.keys(obj[key]).length === 0) {
        delete obj[key];
      }
    }
  }

  return obj;
}

// Process all available locales in resources/i18n
const locales = fs
  .readdirSync(i18nRoot, { withFileTypes: true })
  .filter(
    entry => entry.isDirectory() && fs.existsSync(path.join(i18nRoot, entry.name, 'main.json'))
  )
  .map(entry => entry.name)
  .sort();

let totalRemoved = 0;

for (const locale of locales) {
  const localeData = auditData.locales[locale];
  if (!localeData) {
    continue;
  }

  const keysToRemove = [
    ...new Set([...(localeData.unused || []), ...(localeData.codeUnused || [])]),
  ];
  if (keysToRemove.length === 0) {
    continue;
  }

  const mainFilePath = path.join(i18nRoot, locale, 'main.json');
  let content = JSON.parse(fs.readFileSync(mainFilePath, 'utf8'));

  content = removeKeys(content, keysToRemove);
  content = cleanupEmptyObjects(content);

  fs.writeFileSync(mainFilePath, JSON.stringify(content, null, 2) + '\n', 'utf8');
  console.log(`✓ Cleaned ${keysToRemove.length} unused key(s) from ${locale}/main.json`);
  totalRemoved += keysToRemove.length;
}

if (totalRemoved === 0) {
  console.log('✨ All locales are already clean! No unused keys found.');
} else {
  console.log(`\n✨ Total keys removed across all locales: ${totalRemoved}`);
}
