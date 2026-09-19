#!/usr/bin/env node
/**
 * update-endpoints.cjs
 *
 * Regenerates endpoints.rs from live rclone rcd or JSON dump.
 * Accurately parses and preserves commented endpoints and modules,
 * ensuring only actively used endpoints remain uncommented.
 *
 * Usage:
 *   node scripts/update-endpoints.cjs
 *   npm run sync:endpoints
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Configuration
const DEFAULT_RCLONE_URL = 'http://127.0.0.1:5572';
const PROJECT_ROOT = path.dirname(__dirname);
const DEFAULT_INPUT = path.join(PROJECT_ROOT, 'upload', 'rc.json');
const DEFAULT_OUTPUT = path.join(
  PROJECT_ROOT,
  'src-tauri',
  'src',
  'utils',
  'rclone',
  'endpoints.rs'
);

// Module display order — keeps the file stable across rclone versions.
const MODULE_ORDER = [
  'core',
  'config',
  'job',
  'operations',
  'sync',
  'vfs',
  'mount',
  'fscache',
  'options',
  'serve',
  'backend',
  'debug',
  'pluginsctl',
  'rc',
];

// Module descriptions for headers
const MODULE_DESCRIPTIONS = {
  core: 'Core system endpoints',
  config: 'Configuration endpoints',
  job: 'Job management endpoints',
  operations: 'File operation endpoints',
  sync: 'Synchronization endpoints',
  vfs: 'VFS (Virtual File System) endpoints',
  mount: 'Mount endpoints',
  fscache: 'File system cache endpoints',
  options: 'Option management endpoints',
  serve: 'Serve endpoints',
  backend: 'Backend command endpoints',
  debug: 'Debug endpoints',
  pluginsctl: 'Plugin control endpoints',
  rc: 'Remote control endpoints',
};

function moduleNameDescription(name) {
  return MODULE_DESCRIPTIONS[name] || `${name[0].toUpperCase()}${name.slice(1)} endpoints`;
}

/**
 * Fetch live endpoints from rclone HTTP or CLI.
 */
function getLiveEndpoints(url) {
  try {
    const endpointUrl = url.endsWith('/') ? `${url}rc/list` : `${url}/rc/list`;
    const curlRes = spawnSync('curl', ['-s', '-f', '-m', '2', '-X', 'POST', endpointUrl], {
      encoding: 'utf8',
    });
    if (curlRes.status === 0 && curlRes.stdout) {
      const data = JSON.parse(curlRes.stdout);
      if (Array.isArray(data.commands)) {
        return data.commands;
      }
    }

    const result = spawnSync('rclone', ['rc', 'rc/list', '--rc-no-auth', '--url', url], {
      encoding: 'utf8',
      timeout: 3000,
    });
    if (result.status === 0 && result.stdout) {
      const data = JSON.parse(result.stdout);
      if (Array.isArray(data.commands)) {
        return data.commands;
      }
    }
  } catch {
    // Ignore errors and proceed to fallbacks
  }
  return null;
}

/**
 * Load endpoints from a JSON dump.
 */
function loadFromJson(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    return data.commands || [];
  } catch (e) {
    console.warn(`Error reading JSON from ${filePath}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch endpoints from live source, CLI, or fallback file.
 */
function getSourceEndpoints(url, inputPath) {
  if (inputPath && fs.existsSync(inputPath)) {
    console.log(`Reading endpoints from JSON: ${inputPath}...`);
    return loadFromJson(inputPath);
  }

  console.log(`Checking live rclone at ${url}...`);
  const live = getLiveEndpoints(url);
  if (live && live.length > 0) {
    console.log(`Successfully fetched ${live.length} endpoints from live rclone (${url}).`);
    return live;
  }

  if (fs.existsSync(DEFAULT_INPUT)) {
    console.log(`Reading endpoints from default JSON: ${DEFAULT_INPUT}...`);
    return loadFromJson(DEFAULT_INPUT);
  }

  return null;
}

/**
 * Convert "core/bwlimit" -> "BWLIMIT"
 *        "config/oauth-status" -> "OAUTH_STATUS"
 */
function pathToConstName(fullPath) {
  const slashIdx = fullPath.indexOf('/');
  if (slashIdx === -1) return scream(fullPath);
  const rest = fullPath.slice(slashIdx + 1);
  return scream(rest);
}

function scream(s) {
  return s
    .split(/[-_]/)
    .map(p => p.toUpperCase())
    .join('_');
}

/**
 * Parse existing endpoints.rs file, preserving:
 * - active vs commented-out const definitions
 * - active vs commented-out modules
 * - existing const names
 * - doc comments
 */
function parseExistingEndpoints(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { endpoints: new Map(), modules: new Map() };
  }

  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const endpoints = new Map();
  const modules = new Map();

  let currentMod = null;
  let currentModCommented = false;
  let currentDocs = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check module start: "pub mod name {" or "// pub mod name {"
    const modMatch = /^\s*(?:\/\/\s*)?pub mod\s+(\w+)\s*\{/.exec(line);
    if (modMatch) {
      currentMod = modMatch[1];
      currentModCommented = /^\s*\/\//.test(line);
      modules.set(currentMod, {
        name: currentMod,
        commented: currentModCommented,
        commands: [],
      });
      currentDocs = [];
      continue;
    }

    // Check module end: "}" or "// }"
    const modEndMatch = /^\s*(?:\/\/\s*)?\}/.exec(line);
    if (modEndMatch && currentMod) {
      currentMod = null;
      currentDocs = [];
      continue;
    }

    // Check doc comment line: "/// ...", "    // /// ...", "//     /// ...", "// /// ..."
    const docMatch = /^\s*(?:\/\/\s*)?\/\/\/(.*)$/.exec(line);
    if (docMatch) {
      const text = docMatch[1].replace(/^\s?/, '');
      currentDocs.push(text);
      continue;
    }

    // Check pub const line: "    pub const NAME: &str = "path";" or "    // pub const ..." or "//     pub const ..."
    const constMatch = /^\s*(?:\/\/\s*)?pub const\s+(\w+)\s*:\s*&str\s*=\s*"([^"]+)"/.exec(line);
    if (constMatch) {
      const constName = constMatch[1];
      const pathStr = constMatch[2];
      const isCommented = /^\s*\/\//.test(line) || currentModCommented;
      const title = currentDocs[0] || '';
      let help = '';
      if (currentDocs.length > 2 && currentDocs[1] === '') {
        help = currentDocs.slice(2).join('\n');
      } else if (currentDocs.length > 1) {
        help = currentDocs.slice(1).join('\n');
      }

      const ep = {
        Path: pathStr,
        constName: constName,
        Title: title,
        Help: help,
        isCommented: isCommented,
        module: currentMod,
      };

      endpoints.set(pathStr, ep);
      if (currentMod && modules.has(currentMod)) {
        modules.get(currentMod).commands.push(ep);
      }
      currentDocs = [];
      continue;
    }

    // Reset doc buffer on non-comment, non-empty lines
    if (!/^\s*\/\//.test(line) && !/^\s*$/.test(line)) {
      currentDocs = [];
    }
  }

  return { endpoints, modules };
}

/**
 * Format markdown/help text into rust doc comment lines.
 */
function docLines(text) {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\t/g, '    ');
  const rawLines = normalized.split('\n');
  const stripped = rawLines.map(l => l.replace(/\s+$/, ''));
  const LIST_RE = /^\s*[-*]\s+/;
  const out = [];
  let inList = false;
  let listIndent = 0;

  for (const line of stripped) {
    if (line.length === 0) {
      inList = false;
      out.push('');
      continue;
    }
    if (LIST_RE.test(line)) {
      inList = true;
      listIndent = line.match(/^\s*/)[0].length;
      out.push(line);
      continue;
    }
    if (inList) {
      const S = line.match(/^\s*/)[0].length;
      const target = Math.max(S, listIndent + 2);
      const trimmed = line.trimStart();
      const paddedLine = ' '.repeat(target) + trimmed;
      out.push(paddedLine);
    } else {
      out.push(line);
    }
  }
  return out;
}

function formatDocLine(line, isCommented, isModuleCommented) {
  if (isModuleCommented) {
    return line ? `//     /// ${line}` : `//     ///`;
  }
  if (isCommented) {
    return line ? `    // /// ${line}` : `    // ///`;
  }
  return line ? `    /// ${line}` : `    ///`;
}

function formatConstLine(constName, pathStr, isCommented, isModuleCommented) {
  if (isModuleCommented) {
    return `//     pub const ${constName}: &str = "${pathStr}";`;
  }
  if (isCommented) {
    return `    // pub const ${constName}: &str = "${pathStr}";`;
  }
  return `    pub const ${constName}: &str = "${pathStr}";`;
}

/**
 * Render a single const definition with its doc comments.
 */
function renderConst(cmd, isModuleCommented) {
  const lines = [];
  const title = (cmd.Title || '').trim();
  const hasHelp = Boolean(cmd.Help && cmd.Help.trim().length > 0);

  if (title) {
    lines.push(formatDocLine(title, cmd.isCommented, isModuleCommented));
    if (hasHelp) {
      lines.push(formatDocLine('', cmd.isCommented, isModuleCommented));
    }
  }

  if (hasHelp) {
    const helpLines = docLines(cmd.Help);
    for (const l of helpLines) {
      lines.push(formatDocLine(l, cmd.isCommented, isModuleCommented));
    }
  }

  lines.push(formatConstLine(cmd.constName, cmd.Path, cmd.isCommented, isModuleCommented));
  return lines.join('\n');
}

/**
 * Render a module with all its commands.
 * If all commands in a module are commented, the entire module is commented out.
 */
function renderModule(name, commands) {
  const isModuleCommented = commands.every(c => c.isCommented);
  const desc = moduleNameDescription(name);
  const lines = [];

  if (isModuleCommented) {
    lines.push(`// /// ${desc}`);
    lines.push(`// pub mod ${name} {`);
  } else {
    lines.push(`/// ${desc}`);
    lines.push(`pub mod ${name} {`);
  }

  for (const cmd of commands) {
    lines.push('');
    lines.push(renderConst(cmd, isModuleCommented));
  }

  lines.push(isModuleCommented ? `// }` : `}`);
  return lines.join('\n');
}

function groupCommands(commands) {
  const groups = {};
  for (const cmd of commands) {
    const slashIdx = cmd.Path.indexOf('/');
    const group = slashIdx === -1 ? cmd.Path : cmd.Path.slice(0, slashIdx);
    if (!groups[group]) groups[group] = [];
    groups[group].push(cmd);
  }
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => a.Path.localeCompare(b.Path));
  }
  return groups;
}

function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    url: DEFAULT_RCLONE_URL,
    prune: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--input':
        opts.input = argv[++i];
        break;
      case '--output':
        opts.output = argv[++i];
        break;
      case '--url':
        opts.url = argv[++i];
        break;
      case '--prune':
        opts.prune = true;
        break;
      case '--help':
      case '-h':
        console.log(
          `update-endpoints.cjs — regenerate endpoints.rs from rclone rc/list\n\nUsage:\n  node scripts/update-endpoints.cjs [--url http://127.0.0.1:5572] [--input rc.json] [--output endpoints.rs] [--prune]`
        );
        process.exit(0);
        break;
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 1. Parse existing endpoints.rs
  const { endpoints: existingEndpointsMap, modules: existingModulesMap } = parseExistingEndpoints(
    opts.output
  );

  // 2. Load commands from source (live rclone, CLI, or JSON)
  const sourceCommands = getSourceEndpoints(
    opts.url,
    fs.existsSync(opts.input) ? opts.input : null
  );

  if (!sourceCommands || sourceCommands.length === 0) {
    if (existingEndpointsMap.size > 0) {
      console.warn(
        'Could not connect to live rclone or find input JSON. Preserving existing definitions in endpoints.rs.'
      );
      return;
    }
    console.error('No endpoints found to process.');
    process.exit(1);
  }

  // 3. Merge source commands with existing definitions
  const mergedMap = new Map();
  let newlyCommentedCount = 0;
  let updatedDocsCount = 0;

  for (const srcCmd of sourceCommands) {
    const existing = existingEndpointsMap.get(srcCmd.Path);
    if (existing) {
      // Retain existing constName and comment status; update docs
      mergedMap.set(srcCmd.Path, {
        Path: srcCmd.Path,
        constName: existing.constName,
        Title: srcCmd.Title || existing.Title || '',
        Help: srcCmd.Help || existing.Help || '',
        isCommented: existing.isCommented,
      });
      updatedDocsCount++;
    } else {
      // New endpoint from rclone: keep commented out since it is not in the in-use list
      mergedMap.set(srcCmd.Path, {
        Path: srcCmd.Path,
        constName: pathToConstName(srcCmd.Path),
        Title: srcCmd.Title || '',
        Help: srcCmd.Help || '',
        isCommented: true,
      });
      newlyCommentedCount++;
    }
  }

  // Preserve any endpoints present in existing file but missing from source (unless --prune)
  let retainedCount = 0;
  if (!opts.prune) {
    for (const [pathStr, existing] of existingEndpointsMap.entries()) {
      if (!mergedMap.has(pathStr)) {
        mergedMap.set(pathStr, existing);
        retainedCount++;
      }
    }
  }

  const finalCommands = Array.from(mergedMap.values());
  const activeCount = finalCommands.filter(c => !c.isCommented).length;
  const commentedCount = finalCommands.filter(c => c.isCommented).length;

  console.log(
    `Processed ${finalCommands.length} endpoints: ${activeCount} active (in use), ${commentedCount} commented out (${updatedDocsCount} updated docs, ${newlyCommentedCount} new added as commented, ${retainedCount} retained from file).`
  );

  // 4. Group by module and order
  const groups = groupCommands(finalCommands);
  const ordered = Object.keys(groups).sort((a, b) => {
    const ia = MODULE_ORDER.indexOf(a);
    const ib = MODULE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  // 5. Render output
  const header = [
    '// Rclone Remote Control (RC) API endpoints',
    '//',
    '// This module provides organized access to all rclone RC API endpoints.',
    '// The endpoints are categorized for easier management and discovery.',
    '//',
    `// Generated by update-endpoints.cjs.`,
    `// Total: ${finalCommands.length} endpoints across ${ordered.length} modules (${activeCount} active, ${commentedCount} commented).`,
    '//',
    '// To regenerate:',
    '//   npm run sync:endpoints',
    '',
  ].join('\n');

  const body = ordered.map(name => renderModule(name, groups[name])).join('\n\n');
  const out = header + body + '\n';

  // 6. Write output
  const outDir = path.dirname(opts.output);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(opts.output, out, 'utf8');
  console.log(
    `Wrote ${opts.output} (${finalCommands.length} endpoints in ${ordered.length} modules).`
  );

  for (const name of ordered) {
    const modCmds = groups[name];
    const modActive = modCmds.filter(c => !c.isCommented).length;
    const modCommented = modCmds.filter(c => c.isCommented).length;
    console.log(
      `  - ${name}: ${modCmds.length} endpoints (${modActive} active, ${modCommented} commented)`
    );
  }
}

if (require.main === module) {
  main();
}
