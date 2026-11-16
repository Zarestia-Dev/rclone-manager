#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const i18nRoot = path.join(repoRoot, 'resources', 'i18n');
const args = new Set(process.argv.slice(2));
const strictMode = args.has('--strict');
const jsonMode = args.has('--json');

// Keep in sync with PLURAL_FORMS and isPluralGroup in src/app/services/i18n/plural.ts.
const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
// The Rust backend resolves these sections itself and cannot pick a plural form.
const RUST_SECTIONS = ['tray', 'notification', 'powerInhibitor', 'alerts', 'backendErrors'];

const backendFiles = ['core', 'server', 'desktop'].flatMap(crate =>
  collectFiles(path.join(repoRoot, 'backend', crate, 'src'), ['.rs'])
);
const frontendFiles = collectFiles(path.join(repoRoot, 'src'), ['.ts', '.html']);
const localeFiles = collectLocaleFiles(i18nRoot);

const englishLocalePath = path.join(i18nRoot, 'en-US', 'main.json');
const englishTree = readJson(englishLocalePath);
const englishKeys = flattenKeys(englishTree);
const englishPluralGroups = collectPluralGroups(englishTree);

// Build the set of all internal JSON node paths (prefixes) for validating indirect refs
const englishPrefixes = flattenPrefixes(englishTree);

const usage = collectUsage([...backendFiles, ...frontendFiles], englishKeys, englishPrefixes);
const englishMissingFromCode = diff(usage.combined, englishKeys);

const report = {
  reference: path.relative(repoRoot, englishLocalePath),
  locales: {},
  usage: {
    backend: usage.backend.size,
    frontend: usage.frontend.size,
    combined: usage.combined.size,
    dynamicPrefixes: usage.dynamicPrefixes.size,
  },
};

let missingCount = 0;
let unusedCount = 0;
let codeUnusedCount = 0;
let pluralCount = 0;

for (const localeFile of localeFiles) {
  const localeName = path.basename(path.dirname(localeFile));
  const localeTree = readJson(localeFile);
  const localeKeys = flattenKeys(localeTree);
  const localeMissing =
    localeName === 'en-US' ? englishMissingFromCode : diff(englishKeys, localeKeys);
  const localeUnused = localeName === 'en-US' ? [] : diff(localeKeys, englishKeys);
  const localeCodeUnused = findCodeUnused(localeKeys, usage);

  const localePlural = findPluralProblems(localeName, localeTree, englishPluralGroups);

  pluralCount += localePlural.length;
  missingCount += localeMissing.length;
  unusedCount += localeUnused.length;
  codeUnusedCount += localeCodeUnused.length;

  report.locales[localeName] = {
    missing: localeMissing,
    unused: localeUnused,
    codeUnused: localeCodeUnused,
    plural: localePlural,
  };
}

if (jsonMode) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  printReport(report);
}

if (strictMode && (missingCount > 0 || unusedCount > 0 || codeUnusedCount > 0 || pluralCount > 0)) {
  process.exitCode = 1;
}

// ── File collection ───────────────────────────────────────────────────────────

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
  return collectFiles(rootDir, ['.json']).filter(file => path.basename(file) === 'main.json');
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
    if (child && typeof child === 'object' && !Array.isArray(child) && !isPluralGroup(child)) {
      flattenKeys(child, nextKey, result);
    } else {
      result.add(nextKey);
    }
  }

  return result;
}

/**
 * Collect all internal (non-leaf) node paths in the JSON tree.
 * For {"a": {"b": {"c": "val"}}}, returns Set(["a", "a.b"]).
 * This lets us validate that a string literal is at least a valid prefix
 * of an i18n key path.
 */
function flattenPrefixes(value, prefix = '', result = new Set()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result;
  }

  for (const [key, child] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child) && !isPluralGroup(child)) {
      result.add(nextKey);
      flattenPrefixes(child, nextKey, result);
    }
  }

  return result;
}

// ── Plural groups ─────────────────────────────────────────────────────────────

/**
 * A plural string is an object of plural forms that has `other`:
 * {"one": "{{count}} file", "other": "{{count}} files"}.
 * It is one key (`PluralCompiler` in the app picks the form), not a prefix of several.
 */
function isPluralGroup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.includes('other') &&
    keys.every(key => PLURAL_FORMS.includes(key) && typeof value[key] === 'string')
  );
}

function collectPluralGroups(value, prefix = '', result = new Map()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (isPluralGroup(child)) {
      result.set(nextKey, child);
    } else {
      collectPluralGroups(child, nextKey, result);
    }
  }
  return result;
}

/** The forms a language needs for whole numbers (`many` is only used by some languages). */
function requiredPluralForms(locale) {
  let rules;
  try {
    rules = new Intl.PluralRules(locale);
  } catch {
    rules = new Intl.PluralRules('en-US');
  }
  const forms = new Set(['other']); // `other` is also the fallback of every form
  for (let count = 0; count <= 1000; count++) {
    forms.add(rules.select(count));
  }
  return forms;
}

function placeholders(text) {
  return [
    ...new Set([...text.matchAll(/\{\{\s*([^{}\s]+)\s*\}\}/g)].map(match => match[1])),
  ].sort();
}

function getAtPath(tree, dottedPath) {
  return dottedPath.split('.').reduce((node, part) => (node ? node[part] : undefined), tree);
}

/**
 * Plural strings of English that the locale does not translate as a plural, that lack a form
 * the language uses, or whose forms drop or add a `{{placeholder}}`.
 */
function findPluralProblems(localeName, localeTree, englishPluralGroups) {
  const required = requiredPluralForms(localeName);
  const problems = [];
  for (const [key, english] of englishPluralGroups) {
    if (localeName === 'en-US') {
      if (RUST_SECTIONS.includes(key.split('.')[0])) {
        problems.push(`${key} (Rust cannot pick a plural form; use "Label: {{count}}")`);
      }
      if (!placeholders(english.other).includes('count')) {
        problems.push(`${key} (the number must be {{count}})`);
      }
    }
    const group = getAtPath(localeTree, key);
    if (group === undefined) {
      continue; // reported as a missing key
    }
    if (!isPluralGroup(group)) {
      problems.push(`${key} (not a plural)`);
      continue;
    }
    for (const form of required) {
      if (!(form in group)) {
        problems.push(`${key}.${form}`);
      }
    }
    // Every form shows the same values as English, `{{count}}` included.
    const expected = placeholders(english.other).join(',');
    for (const [form, text] of Object.entries(group)) {
      if (placeholders(text).join(',') !== expected) {
        problems.push(`${key}.${form} (placeholders)`);
      }
    }
  }
  return problems.sort();
}

// ── Usage collection ──────────────────────────────────────────────────────────

function collectUsage(files, knownKeys, knownPrefixes) {
  const backend = new Set();
  const frontend = new Set();

  // Dynamic prefixes from patterns like 'prefix.' + variable + '.suffix' | translate
  // Keys matching any of these prefixes are considered "used"
  const dynamicPrefixes = new Set();

  // ── Rust backend regexes ──────────────────────────────────────────────────
  const backendRegexes = [
    /\b(?:crate::)?localized_(?:error|success)!\(\s*"([^"]+)"/g,
    /\bt!\(\s*"([^"]+)"/g,
    // Plain function calls: t("key") and t_with_params("key", ...)
    /\bt(?:_with_params)?\(\s*"([^"]+)"/g,
  ];

  // ── TypeScript regexes ────────────────────────────────────────────────────
  // Direct translate.instant/get/stream('key.path') calls
  const tsDirectRegexes = [
    /\btranslate\.(?:instant|get|stream)\(\s*(['"])([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\1/g,
    /\btranslate\.(?:instant|get|stream)\(\s*`([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)`/g,
  ];

  // Template literal with interpolation: `prefix.${var}.suffix`
  // Extracts the prefix (before ${) as a dynamic prefix
  const tsTemplateDynamicRegex = /`([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\.\$\{/g;

  // Direct translate pipe regex: 'key.path' | translate
  const translatePipeRegex = /['"`]([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)['"`]\s*\|\s*translate/g;

  // Dotted string literals in TS files — validated against known keys/prefixes
  const tsStringLiteralRegex = /(['"`])([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\1/g;

  // Dynamic HTML keys: 'prefix.' + variable + '.suffix' | translate
  // Captures the constant prefix before the + sign
  const htmlDynamicPrefixRegex =
    /['"]([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\.\s*['"]?\s*\+[^|]*\|\s*translate/g;

  // General HTML key extractor for string literals that look like i18n keys
  const htmlStringLiteralRegex = /(['"`])([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\1/g;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const isBackend = file.endsWith('.rs');
    const isHtml = file.endsWith('.html');
    const source = isBackend ? stripRustComments(content) : content;

    if (isBackend) {
      // Direct macro invocations: t!("key"), localized_error!("key"), localized_success!("key")
      for (const regex of backendRegexes) {
        for (const key of extractMatches(source, regex, 1)) {
          backend.add(key);
        }
      }

      // String literals in Rust used as i18n key references (e.g. label_key: "tray.mountCount")
      // Only accept strings that are actual known keys or known prefixes
      const rustStringRegex = /"([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)+)"/g;
      for (const key of extractMatchesNoFilter(source, rustStringRegex, 1)) {
        if (knownKeys.has(key) || knownPrefixes.has(key)) {
          backend.add(key);
        }
      }

      // Rust format! dynamic key prefix regex: e.g. t(&format!("notification.title.{key_prefix}..."))
      const rustFormatDynamicRegex =
        /\bt(?:_with_params)?\(\s*&?format!\(\s*"([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z][a-zA-Z0-9_-]*)+)/g;
      for (const prefix of extractMatchesNoFilter(source, rustFormatDynamicRegex, 1)) {
        if (prefix.includes('.') && knownPrefixes.has(prefix)) {
          dynamicPrefixes.add(prefix);
        }
      }
      continue;
    }

    if (isHtml) {
      // Direct pipe invocations: 'key.path' | translate
      for (const key of extractMatches(source, translatePipeRegex, 1)) {
        frontend.add(key);
      }

      // Ternary pipe invocations: (cond ? 'key.one' : 'key.two') | translate
      const ternaryTranslateRegex =
        /\?\s*['"`]([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)['"`]\s*:\s*['"`]([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)['"`]\s*\)\s*\|\s*translate/g;
      let ternaryMatch;
      while ((ternaryMatch = ternaryTranslateRegex.exec(source)) !== null) {
        if (ternaryMatch[1]) frontend.add(ternaryMatch[1]);
        if (ternaryMatch[2]) frontend.add(ternaryMatch[2]);
      }

      // Dynamic prefix patterns → 'alerts.action.' + kind | translate
      for (const prefix of extractMatchesNoFilter(source, htmlDynamicPrefixRegex, 1)) {
        if (prefix.includes('.') && knownPrefixes.has(prefix)) {
          dynamicPrefixes.add(prefix);
        }
      }

      // Scan for dotted string literals that match known i18n keys or prefixes.
      // This catches ternary operators, newlines before | translate, etc.
      for (const key of extractMatchesNoFilter(source, htmlStringLiteralRegex, 2)) {
        if (knownKeys.has(key)) {
          frontend.add(key);
        } else if (knownPrefixes.has(key)) {
          dynamicPrefixes.add(key);
        }
      }

      continue;
    }

    // ── TypeScript files ──────────────────────────────────────────────────
    // Direct translate calls
    for (const regex of tsDirectRegexes) {
      for (const key of extractMatches(source, regex, 2)) {
        frontend.add(key);
      }
    }

    // Direct pipe invocations in inline templates
    for (const key of extractMatches(source, translatePipeRegex, 1)) {
      frontend.add(key);
    }

    // Template literal dynamic keys → extract prefix
    for (const prefix of extractMatchesNoFilter(source, tsTemplateDynamicRegex, 1)) {
      if (prefix.includes('.') && knownPrefixes.has(prefix)) {
        dynamicPrefixes.add(prefix);
      }
    }

    // Inline HTML templates in TS files can also use dynamic prefix patterns
    for (const prefix of extractMatchesNoFilter(source, htmlDynamicPrefixRegex, 1)) {
      if (prefix.includes('.') && knownPrefixes.has(prefix)) {
        dynamicPrefixes.add(prefix);
      }
    }

    // Scan for dotted string literals that match known i18n keys or prefixes.
    // This catches indirect usages like: label: 'dashboard.appDetail.sync',
    // tooltip: 'overviews.remoteCard.actions.mount', etc.
    for (const key of extractMatchesNoFilter(source, tsStringLiteralRegex, 2)) {
      if (knownKeys.has(key)) {
        frontend.add(key);
      } else if (knownPrefixes.has(key)) {
        // It's a prefix being used dynamically (e.g. assigned to a variable
        // that later gets .suffix appended)
        dynamicPrefixes.add(key);
      }
    }
  }

  return {
    backend,
    frontend,
    dynamicPrefixes,
    combined: new Set([...backend, ...frontend]),
  };
}

/**
 * Finds keys in `localeKeys` that are not directly in `usage.combined`
 * AND not covered by any dynamic prefix in `usage.dynamicPrefixes`.
 */
function findCodeUnused(localeKeys, usageData) {
  const { combined, dynamicPrefixes } = usageData;
  const prefixArray = [...dynamicPrefixes];

  return [...localeKeys]
    .filter(key => {
      // If directly referenced, it's used
      if (combined.has(key)) return false;

      // If any dynamic prefix matches this key, it's dynamically used
      for (const prefix of prefixArray) {
        if (key.startsWith(prefix + '.')) return false;
      }

      return true;
    })
    .sort();
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

function extractMatchesNoFilter(content, regex, groupIndex) {
  const matches = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const key = match[groupIndex];
    if (key) {
      matches.push(key);
    }
  }
  return matches;
}

function stripRustComments(content) {
  const withoutComments = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const testModuleMatch = withoutComments.match(/#\[cfg\(test\)\]\s*(?:#\[.*\]\s*)*mod\s+\w+/);
  return testModuleMatch ? withoutComments.slice(0, testModuleMatch.index) : withoutComments;
}

function diff(left, right) {
  const rightSet = right instanceof Set ? right : new Set(right);
  return [...left].filter(item => !rightSet.has(item)).sort();
}

function printReport(reportData) {
  const MAX_INLINE = 20;

  console.log(`Reference locale: ${reportData.reference}`);
  console.log(
    `Detected usage: backend=${reportData.usage.backend}, frontend=${reportData.usage.frontend}, combined=${reportData.usage.combined}, dynamicPrefixes=${reportData.usage.dynamicPrefixes}`
  );

  for (const localeName of Object.keys(reportData.locales).sort()) {
    const locale = reportData.locales[localeName];
    console.log(`\n[${localeName}]`);
    printKeyList(
      localeName === 'en-US' ? 'Missing vs code' : 'Missing',
      locale.missing,
      MAX_INLINE
    );
    printKeyList('Plural forms missing', locale.plural || [], MAX_INLINE);
    printKeyList('Unused vs English', locale.unused, MAX_INLINE);
    printKeyList('Unused vs code', locale.codeUnused || [], MAX_INLINE);
  }

  console.log(
    `\nTotals: missing=${missingCount}, pluralForms=${pluralCount}, unusedVsEnglish=${unusedCount}, unusedVsCode=${codeUnusedCount}`
  );

  const hasLong = Object.values(reportData.locales).some(
    l =>
      l.missing.length > MAX_INLINE ||
      l.unused.length > MAX_INLINE ||
      (l.codeUnused || []).length > MAX_INLINE
  );
  if (hasLong) {
    console.log(`\nTip: Use --json for the full machine-readable report.`);
  }
}

function printKeyList(label, keys, max) {
  if (!keys.length) {
    console.log(`${label} (0): none`);
    return;
  }
  const shown = keys.slice(0, max);
  const remaining = keys.length - shown.length;
  const suffix = remaining > 0 ? `, ... and ${remaining} more` : '';
  console.log(`${label} (${keys.length}): ${shown.join(', ')}${suffix}`);
}
