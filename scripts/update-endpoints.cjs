#!/usr/bin/env node
/**
 * update-endpoints.cjs
 *
 * Regenerates endpoints.rs from a rclone `rc/list` dump or live rclone rcd.
 * Mirrors the conventions and workflow of update-flags.cjs.
 *
 * Usage:
 *   node scripts/update-endpoints.cjs                    # defaults
 *   node scripts/update-endpoints.cjs --live             # fetch live from default url
 *   node scripts/update-endpoints.cjs --live --url http://127.0.0.1:5572
 *   node scripts/update-endpoints.cjs --input <rc.json> --output <endpoints.rs>
 *   node scripts/update-endpoints.cjs --prune            # remove endpoints missing from source
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

// Endpoints to strip by default
const INTERNAL_DENYLIST = new Set([]);

/**
 * Fetch endpoints from rclone rc/list.
 */
function getEndpoints(url) {
  console.log(`Fetching rc/list from ${url}...`);
  try {
    // 1. Try direct HTTP POST to /rc/list first
    const endpointUrl = url.endsWith('/') ? `${url}rc/list` : `${url}/rc/list`;
    const curlRes = spawnSync('curl', ['-s', '-f', '-X', 'POST', endpointUrl], {
      encoding: 'utf8',
    });
    if (curlRes.status === 0 && curlRes.stdout) {
      const data = JSON.parse(curlRes.stdout);
      return data.commands || [];
    }

    // 2. Fallback to rclone CLI
    const result = spawnSync('rclone', ['rc', 'rc/list', '--rc-no-auth', '--url', url], {
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout) {
      const data = JSON.parse(result.stdout);
      return data.commands || [];
    }

    console.warn(`Could not connect to live rclone at ${url}.`);
    return null;
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn('rclone CLI not in PATH and HTTP connection failed.');
    } else {
      console.warn(`Unexpected error fetching live endpoints: ${e.message}`);
    }
    return null;
  }
}

function loadFromJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  console.log(`Reading ${filePath}...`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  return data.commands || [];
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

function docLines(text, indent) {
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
      out.push(`${indent}///`);
      continue;
    }
    if (LIST_RE.test(line)) {
      inList = true;
      listIndent = line.match(/^\s*/)[0].length;
      out.push(`${indent}/// ${line}`);
      continue;
    }
    if (inList) {
      const S = line.match(/^\s*/)[0].length;
      const target = Math.max(S, listIndent + 2);
      const trimmed = line.trimStart();
      const paddedLine = ' '.repeat(target) + trimmed;
      out.push(`${indent}/// ${paddedLine}`);
    } else {
      out.push(`${indent}/// ${line}`);
    }
  }
  return out;
}

function renderConst(cmd, indent, isNew) {
  const ind = indent;
  const lines = [];
  const title = (cmd.Title || '').trim();
  if (title) {
    lines.push(`${ind}/// ${title}`);
    lines.push(`${ind}///`);
  }
  if (cmd.Help) {
    const helpLines = docLines(cmd.Help, ind);
    for (const l of helpLines) lines.push(l);
  }

  const constLine = `${ind}pub const ${cmd.constName}: &str = "${cmd.Path}";`;
  if (isNew) {
    lines.push(`${ind}/////////////////////////////////////// New Key start`);
    lines.push(constLine);
    lines.push(`${ind}////////////////////////////////////// New key end`);
  } else {
    lines.push(constLine);
  }
  return lines.join('\n');
}

function renderModule(name, commands, isNewSet) {
  const lines = [];
  lines.push(`/// ${moduleNameDescription(name)}`);
  lines.push(`pub mod ${name} {`);
  for (const cmd of commands) {
    lines.push('');
    const isNew = isNewSet.has(cmd.Path);
    lines.push(renderConst(cmd, '    ', isNew));
  }
  lines.push('}');
  return lines.join('\n');
}

function moduleNameDescription(name) {
  const map = {
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
  return map[name] || `${name[0].toUpperCase()}${name.slice(1)} endpoints`;
}

function parseExistingEndpoints(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return new Map();
  const src = fs.readFileSync(filePath, 'utf8');
  const existingMap = new Map();
  const lines = src.split('\n');
  let currentDocs = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\/\//.test(line)) {
      currentDocs.push(line.replace(/^\s*\/\/\/\s?/, ''));
    } else {
      const m = /^\s*pub const\s+(\w+)\s*:\s*&str\s*=\s*"([^"]+)"/.exec(line);
      if (m) {
        const constName = m[1];
        const pathStr = m[2];
        const helpText = currentDocs.join('\n');
        existingMap.set(pathStr, {
          Path: pathStr,
          constName: constName,
          Title: currentDocs[0] || '',
          Help: helpText,
        });
      }
      if (!/^\s*\/\//.test(line)) {
        currentDocs = [];
      }
    }
  }

  return existingMap;
}

function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    live: false,
    url: DEFAULT_RCLONE_URL,
    includeInternal: false,
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
      case '--live':
        opts.live = true;
        break;
      case '--url':
        opts.url = argv[++i];
        break;
      case '--include-internal':
        opts.includeInternal = true;
        break;
      case '--prune':
        opts.prune = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
    }
  }
  return opts;
}

function printHelp() {
  console.log(`update-endpoints.cjs — regenerate endpoints.rs from rclone rc/list

Usage:
  node scripts/update-endpoints.cjs [--input rc.json] [--output endpoints.rs]
                                   [--live [--url http://127.0.0.1:5572]]
                                   [--prune] [--include-internal]`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 1. Load commands from source (live or JSON)
  let sourceCommands = null;
  if (opts.live) {
    sourceCommands = getEndpoints(opts.url);
  } else if (fs.existsSync(opts.input)) {
    sourceCommands = loadFromJson(opts.input);
  }

  if (!sourceCommands && !opts.live) {
    sourceCommands = getEndpoints(opts.url);
  }

  const existingEndpointsMap = parseExistingEndpoints(opts.output);

  if (!sourceCommands || sourceCommands.length === 0) {
    if (existingEndpointsMap.size > 0) {
      console.warn('Could not fetch source endpoints. Preserving existing definitions.');
      sourceCommands = [];
    } else {
      console.error('No endpoints found to process.');
      process.exit(1);
    }
  }

  // 2. Filter internal endpoints unless requested
  const filtered = sourceCommands.filter(c => {
    const denied = INTERNAL_DENYLIST.has(c.Path);
    return opts.includeInternal || !denied;
  });

  // Assign const names for source commands
  for (const c of filtered) {
    c.constName = pathToConstName(c.Path);
  }

  // 3. Merge with existing endpoints if prune is false
  const sourcePathSet = new Set(filtered.map(c => c.Path));
  const finalCommands = [...filtered];
  let retainedCount = 0;

  if (!opts.prune) {
    for (const [pathStr, existingCmd] of existingEndpointsMap.entries()) {
      if (!sourcePathSet.has(pathStr)) {
        finalCommands.push(existingCmd);
        retainedCount++;
      }
    }
  } else {
    const removedCount = existingEndpointsMap.size - sourcePathSet.size;
    if (removedCount > 0) {
      console.log(`  [PRUNE] Removed ${removedCount} unused endpoints`);
    }
  }

  // 4. Identify new endpoints (present in source but not previously in endpoints.rs)
  const isNewSet = new Set();
  for (const c of filtered) {
    if (!existingEndpointsMap.has(c.Path)) {
      isNewSet.add(c.Path);
    }
  }

  console.log(`Total endpoints: ${finalCommands.length} (${filtered.length} from source, ${retainedCount} retained from file, ${isNewSet.size} new)`);

  // 5. Group and order
  const groups = groupCommands(finalCommands);
  const ordered = Object.keys(groups).sort((a, b) => {
    const ia = MODULE_ORDER.indexOf(a);
    const ib = MODULE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  // 6. Render
  const header = [
    '// Rclone Remote Control (RC) API endpoints',
    '//',
    '// This module provides organized access to all rclone RC API endpoints.',
    '// The endpoints are categorized for easier management and discovery.',
    '//',
    `// Generated by update-endpoints.cjs from ${opts.live ? 'live rclone rc/list' : path.basename(opts.input)}.`,
    `// Total: ${finalCommands.length} endpoints across ${ordered.length} modules.`,
    '//',
    '// To regenerate:',
    '//   npm run sync:endpoints',
    '//   npm run sync:endpoints -- --live',
    '//   npm run sync:endpoints -- --live --url http://127.0.0.1:5572',
    '',
  ].join('\n');

  const body = ordered.map(name => renderModule(name, groups[name], isNewSet)).join('\n\n');
  const out = header + body + '\n';

  // 7. Write output
  const outDir = path.dirname(opts.output);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(opts.output, out, 'utf8');
  console.log(`Wrote ${opts.output} (${finalCommands.length} endpoints in ${ordered.length} modules).`);

  for (const name of ordered) {
    console.log(`  - ${name}: ${groups[name].length}`);
  }
}

if (require.main === module) {
  main();
}
