const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Configuration
const DEFAULT_RCLONE_URL = 'http://127.0.0.1:51900';
const PROJECT_ROOT = path.dirname(__dirname);
const I18N_DIR = path.join(PROJECT_ROOT, 'resources', 'i18n');

/**
 * Fetch flags from rclone rc options/info.
 */
function getFlags(url) {
  console.log(`Fetching flags from ${url}...`);
  try {
    const result = spawnSync(
      'rclone',
      ['rc', 'options/info', '--rc-no-auth', '--url', url],
      { encoding: 'utf8' }
    );

    if (result.status !== 0) {
      console.error(`Error calling rclone: ${result.stderr}`);
      console.log("Ensure rclone is running with 'rclone rcd --rc-no-auth --rc-addr :51900' or similar.");
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
        help: helpText
      };
    }
  }
  return flags;
}

/**
 * Simple title case helper.
 */
function titleCase(s) {
  return s.split(/[-_]/).map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

/**
 * Formats a new key/value pair with the specific comment block.
 */
function formatNewKeyBlock(key, value, indent = 2) {
  const jsonStr = JSON.stringify({ [key]: value }, null, indent);
  const lines = jsonStr.split('\n');
  let content;
  if (lines.length >= 3) {
    content = lines.slice(1, -1).join('\n');
  } else {
    content = `"${key}": ${JSON.stringify(value)}`;
  }

  const spaces = ' '.repeat(indent);
  return `\n${spaces}/////////////////////////////////////// New Key start\n${content},\n${spaces}////////////////////////////////////// New key end`;
}

/**
 * Updates a single rclone.json file.
 */
function updateFile(filePath, flagsData) {
  console.log(`Checking ${filePath}...`);

  let content;
  let currentData;
  try {
    content = fs.readFileSync(filePath, 'utf8');
    currentData = JSON.parse(content);
  } catch (e) {
    console.warn(`  Skipping invalid or missing file: ${filePath}`);
    return;
  }

  const missingKeys = [];
  for (const [key, val] of Object.entries(flagsData)) {
    if (!(key in currentData)) {
      missingKeys.push([key, val]);
    }
  }

  if (missingKeys.length === 0) {
    console.log(`  No missing keys in ${filePath}`);
    return;
  }

  console.log(`  Found ${missingKeys.length} missing keys in ${filePath}`);

  const lastBraceIdx = content.lastIndexOf('}');
  if (lastBraceIdx === -1) {
    console.warn('  Could not find closing brace. Skipping.');
    return;
  }

  let i = lastBraceIdx - 1;
  let needsComma = false;
  while (i >= 0) {
    const char = content[i];
    if (char.trim() === '') {
      i--;
      continue;
    }
    if (char === ',' || char === '{' || char === '[') {
      needsComma = false;
    } else {
      needsComma = true;
    }
    break;
  }

  const newBlocks = missingKeys.map(([key, val]) => formatNewKeyBlock(key, val, 2));
  const fullInsertion = newBlocks.join('');

  let finalContent;
  if (needsComma) {
    finalContent = content.slice(0, i + 1) + ',' + content.slice(i + 1, lastBraceIdx) + fullInsertion + '\n' + content.slice(lastBraceIdx);
  } else {
    finalContent = content.slice(0, lastBraceIdx) + fullInsertion + '\n' + content.slice(lastBraceIdx);
  }

  fs.writeFileSync(filePath, finalContent, 'utf8');
  console.log(`  Updated ${filePath}`);
}

/**
 * Main function.
 */
function main() {
  const args = process.argv.slice(2);
  let url = DEFAULT_RCLONE_URL;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) {
      url = args[i + 1];
      break;
    }
  }

  const flags = getFlags(url);
  if (!flags) process.exit(1);

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
        updateFile(targetFile, flags);
      }
    }
  }
}

if (require.main === module) {
  main();
}
