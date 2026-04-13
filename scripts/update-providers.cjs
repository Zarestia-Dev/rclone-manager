const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Configuration
const DEFAULT_RCLONE_URL = 'http://127.0.0.1:51900';
const PROJECT_ROOT = path.dirname(__dirname);
const I18N_DIR = path.join(PROJECT_ROOT, 'resources', 'i18n');

/**
 * Fetch providers from rclone rc.
 */
function getProviders(url) {
  console.log(`Fetching providers from ${url}...`);
  try {
    const result = spawnSync(
      'rclone',
      ['rc', 'config/providers', '--rc-no-auth', '--url', url],
      { encoding: 'utf8' }
    );

    if (result.status !== 0) {
      console.error(`Error calling rclone: ${result.stderr}`);
      console.log("Ensure rclone is running with 'rclone rcd --rc-no-auth --rc-addr :51900' or similar.");
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
  return s.replace(/_/g, ' ').replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}

/**
 * Formats a new key/value pair with the specific comment block.
 */
function formatNewKeyBlock(key, value, indent = 4) {
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
 * Updates a single rclone-providers.json file.
 */
function updateFile(filePath, providersData) {
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

  if (!currentData.providers) {
    console.warn(`  No 'providers' key in ${filePath}`);
    return;
  }

  const fetchedProviders = providersData.providers || [];
  const providerMap = Object.fromEntries(fetchedProviders.map(p => [p.Name, p]));

  let updatedContent = content;

  // Process providers
  for (const [pName, pDef] of Object.entries(providerMap)) {
    if (currentData.providers[pName]) {
      // Check options
      const existingOptions = currentData.providers[pName];
      const fetchedOptions = pDef.Options || [];

      const missingOptions = fetchedOptions.filter(opt => opt.Name && !existingOptions[opt.Name]);

      if (missingOptions.length > 0) {
        console.log(`  [UPDATE] ${pName} missing ${missingOptions.length} options`);

        // Find the location of provider in text
        const pStartRegex = new RegExp(`"${pName}"\\s*:\\s*\\{`);
        const pStartMatch = updatedContent.match(pStartRegex);
        if (!pStartMatch) {
          console.warn(`  Could not find start of provider ${pName} in text. Skipping.`);
          continue;
        }

        const startIdx = pStartMatch.index;
        let braceCount = 0;
        let endIdx = -1;
        let foundStart = false;

        for (let i = startIdx; i < updatedContent.length; i++) {
          const char = updatedContent[i];
          if (char === '{') {
            braceCount++;
            foundStart = true;
          } else if (char === '}') {
            braceCount--;
            if (foundStart && braceCount === 0) {
              endIdx = i;
              break;
            }
          }
        }

        if (endIdx !== -1) {
          const linesToInsert = missingOptions.map(opt => {
            const val = {
              title: titleCase(opt.Name),
              help: opt.Help || ''
            };
            return formatNewKeyBlock(opt.Name, val, 6);
          });

          const fullInsertion = linesToInsert.join('');
          updatedContent = updatedContent.slice(0, endIdx) + fullInsertion + '\n    ' + updatedContent.slice(endIdx);
        }
      }
    } else {
      // New Provider entirely
      console.log(`  [NEW] Missing provider ${pName}`);
      // Find "providers": { ... } closing brace
      // This is a bit more complex, we'll try to find the "providers" key block
      const providersMatch = updatedContent.match(/"providers"\s*:\s*\{/);
      if (providersMatch) {
        let braceCount = 0;
        let endIdx = -1;
        let foundStart = false;
        for (let i = providersMatch.index; i < updatedContent.length; i++) {
          const char = updatedContent[i];
          if (char === '{') {
            braceCount++;
            foundStart = true;
          } else if (char === '}') {
            braceCount--;
            if (foundStart && braceCount === 0) {
              endIdx = i;
              break;
            }
          }
        }

        if (endIdx !== -1) {
          const optData = {};
          (pDef.Options || []).forEach(opt => {
             if (opt.Name) {
               optData[opt.Name] = {
                 title: titleCase(opt.Name),
                 help: opt.Help || ''
               };
             }
          });

          const block = formatNewKeyBlock(pName, optData, 4);
          updatedContent = updatedContent.slice(0, endIdx) + block + '\n  ' + updatedContent.slice(endIdx);
        }
      }
    }
  }

  // Save
  if (updatedContent !== content) {
    fs.writeFileSync(filePath, updatedContent, 'utf8');
    console.log(`  Updated ${filePath}`);
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
        updateFile(targetFile, providers);
      }
    }
  }
}

if (require.main === module) {
  main();
}
