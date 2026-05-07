#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const i18nRoot = path.join(repoRoot, 'resources', 'i18n');
const args = new Set(process.argv.slice(2));
const strictMode = args.has('--strict');
const jsonMode = args.has('--json');
const codeUnusedMode = args.has('--code-unused');

const backendFiles = collectFiles(path.join(repoRoot, 'src-tauri', 'src'), ['.rs']);
const frontendFiles = collectFiles(path.join(repoRoot, 'src'), ['.ts', '.html']);
const localeFiles = collectLocaleFiles(i18nRoot);

const englishLocalePath = path.join(i18nRoot, 'en-US', 'main.json');
const englishTree = readJson(englishLocalePath);
const englishKeys = flattenKeys(englishTree);
const usage = collectUsage([...backendFiles, ...frontendFiles]);
const englishMissingFromCode = diff(usage.combined, englishKeys);

const report = {
  reference: path.relative(repoRoot, englishLocalePath),
  locales: {},
  usage: {
    backend: usage.backend.size,
    frontend: usage.frontend.size,
    combined: usage.combined.size,
  },
};

let missingCount = 0;
let unusedCount = 0;
let codeUnusedCount = 0;

for (const localeFile of localeFiles) {
  const localeName = path.basename(path.dirname(localeFile));
  const localeTree = readJson(localeFile);
  const localeKeys = flattenKeys(localeTree);
  const localeMissing = localeName === 'en-US' ? englishMissingFromCode : diff(englishKeys, localeKeys);
  const localeUnused = localeName === 'en-US' ? [] : diff(localeKeys, englishKeys);
  const localeCodeUnused = diff(localeKeys, usage.combined);

  missingCount += localeMissing.length;
  unusedCount += localeUnused.length;
  codeUnusedCount += localeCodeUnused.length;

  report.locales[localeName] = {
    missing: localeMissing,
    unused: localeUnused,
    ...(codeUnusedMode ? { codeUnused: localeCodeUnused } : {}),
  };
}

if (jsonMode) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  printReport(report);
}

if (strictMode && (missingCount > 0 || unusedCount > 0)) {
  process.exitCode = 1;
}

function collectFiles(rootDir, extensions) {
  const result = [];
  if (!fs.existsSync(rootDir)) {
    return result;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (extensions.includes(path.extname(entry.name))) {
        result.push(fullPath);
      }
    }
  }

  return result;
}

function collectLocaleFiles(rootDir) {
  return collectFiles(rootDir, ['.json']).filter((file) => path.basename(file) === 'main.json');
}

function shouldSkipDir(name) {
  return name === 'node_modules' || name === 'dist' || name === 'target' || name === '.git';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function flattenKeys(value, prefix = '', result = new Set()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result;
  }

  for (const [key, child] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flattenKeys(child, nextKey, result);
    } else {
      result.add(nextKey);
    }
  }

  return result;
}

function collectUsage(files) {
  const backend = new Set();
  const frontend = new Set();

  const backendRegexes = [
    /\b(?:crate::)?localized_(?:error|success)!\(\s*"([^"]+)"/g,
    /\bt!\(\s*"([^"]+)"/g,
  ];

  const tsRegexes = [
    /\btranslate\.(?:instant|get|stream)\(\s*(['"])([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\1/g,
    /\btranslate\.(?:instant|get|stream)\(\s*`([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)`/g,
  ];

  const htmlLiteralRegex = /(['"`])([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\1\s*\|\s*translate\b/g;
  const htmlKeyRegex = /(['"`])([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\1/g;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const isBackend = file.endsWith('.rs');
    const isHtml = file.endsWith('.html');
    const source = isBackend ? stripRustComments(content) : content;

    if (isBackend) {
      for (const regex of backendRegexes) {
        for (const key of extractMatches(source, regex, 1)) {
          backend.add(key);
        }
      }
      continue;
    }

    if (isHtml) {
      for (const key of extractMatches(source, htmlLiteralRegex, 2)) {
        frontend.add(key);
      }

      for (const line of source.split(/\r?\n/)) {
        if (!line.includes('| translate')) {
          continue;
        }

        htmlKeyRegex.lastIndex = 0;
        let match;
        while ((match = htmlKeyRegex.exec(line)) !== null) {
          const translateIndex = line.indexOf('| translate', match.index);
          if (translateIndex < 0) {
            continue;
          }

          const trailingContext = line.slice(match.index + match[0].length, translateIndex);
          if (trailingContext.includes('>') || trailingContext.includes('=')) {
            continue;
          }

          frontend.add(match[2]);
        }
      }

      continue;
    }

    for (const regex of tsRegexes) {
      for (const key of extractMatches(source, regex, 2)) {
        frontend.add(key);
      }
    }
  }

  return {
    backend,
    frontend,
    combined: new Set([...backend, ...frontend]),
  };
}

function extractMatches(content, regex, groupIndex) {
  const matches = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const key = match[groupIndex];
    if (key && key.includes('.')) {
      matches.push(key);
    }
  }
  return matches;
}

function stripRustComments(content) {
  const withoutComments = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const testBlockIndex = withoutComments.indexOf('#[cfg(test)]');
  return testBlockIndex >= 0 ? withoutComments.slice(0, testBlockIndex) : withoutComments;
}

function diff(left, right) {
  const rightSet = right instanceof Set ? right : new Set(right);
  return [...left].filter((item) => !rightSet.has(item)).sort();
}

function printReport(reportData) {
  console.log(`Reference locale: ${reportData.reference}`);
  console.log(`Detected usage: backend=${reportData.usage.backend}, frontend=${reportData.usage.frontend}, combined=${reportData.usage.combined}`);

  for (const localeName of Object.keys(reportData.locales).sort()) {
    const locale = reportData.locales[localeName];
    console.log(`\n[${localeName}]`);
    console.log(
      `${localeName === 'en-US' ? 'Missing vs code' : 'Missing'} (${locale.missing.length}): ${locale.missing.length ? locale.missing.join(', ') : 'none'}`
    );
    console.log(`Unused vs English (${locale.unused.length}): ${locale.unused.length ? locale.unused.join(', ') : 'none'}`);
    if (codeUnusedMode) {
      const codeUnused = locale.codeUnused || [];
      console.log(`Unused vs code (${codeUnused.length}): ${codeUnused.length ? codeUnused.join(', ') : 'none'}`);
    }
  }

  if (codeUnusedMode) {
    console.log(`\nTotals: missing=${missingCount}, unusedVsEnglish=${unusedCount}, unusedVsCode=${codeUnusedCount}`);
  } else {
    console.log(`\nTotals: missing=${missingCount}, unusedVsEnglish=${unusedCount}`);
  }
}