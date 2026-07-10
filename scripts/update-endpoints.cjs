#!/usr/bin/env node
/**
 * update-endpoints.cjs
 *
 * Regenerates endpoints.rs from a rclone `rc/list` dump (rc.json).
 *
 * Usage:
 *   node update-endpoints.cjs --input <rc.json> --output <endpoints.rs>
 *   node update-endpoints.cjs                    # defaults below
 *   node update-endpoints.cjs --live             # fetch rc/list from a running rclone
 *   node update-endpoints.cjs --live --url http://127.0.0.1:5572
 *
 * Behaviour:
 *   1. Reads the rc.json file (or fetches rc/list from a running rclone rcd).
 *   2. Groups commands by their first path segment (e.g. "core", "config", ...).
 *   3. For each group, emits a `pub mod <group> { ... }` block containing
 *      `pub const NAME: &str = "<group>/<rest>";` entries.
 *   4. Skips a configurable deny-list of internal/test endpoints (rc/panic,
 *      rc/noop, etc.) — override with --include-internal.
 *   5. Preserves custom additions that are NOT in rc.json by accepting a
 *      --extras file (JSON map of path -> {title, help, const}). If omitted,
 *      the default extras (config/oauthstatus, config/oauthstop) are emitted.
 *   6. Adds a `/////////////////////////////////////// New Key start/end` marker
 *      around any endpoint that exists in rc.json but was not previously
 *      present in the output file, mirroring the convention used by
 *      update-flags.cjs. (Driven by a --previous flag pointing to the old
 *      endpoints.rs; if absent, the first run marks everything as new.)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- defaults -------------------------------------------------------------
const DEFAULT_INPUT = path.join(__dirname, '..', 'upload', 'rc.json');
const DEFAULT_OUTPUT = path.join(
  __dirname,
  '..',
  'src-tauri',
  'src',
  'utils',
  'rclone',
  'endpoints.rs'
);
const DEFAULT_EXTRAS = null; // path to JSON, or null for built-in defaults
const DEFAULT_RCLONE_URL = 'http://127.0.0.1:5572';

// Module display order — keeps the file stable across rclone versions.
// Anything not listed here is appended alphabetically.
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

// Default extras — endpoints we want to expose even though upstream rclone
// doesn't list them (e.g. custom OAuth helpers compiled into a downstream
// build). Skip by passing --no-extras.
const DEFAULT_EXTRA_ENDPOINTS = {
  'config/oauthstatus': {
    const: 'OAUTHSTATUS',
    title: 'Get the current OAuth server status.',
    help:
      'Returns the status of the in-process OAuth auth server:\n\n' +
      '```json\n' +
      '{\n' +
      '    "running": true,\n' +
      '    "authUrl": "https://accounts.google.com/o/oauth2/auth?..."\n' +
      '}\n' +
      '```\n\n' +
      '- `running` - bool, whether the OAuth server is currently listening\n' +
      '- `authUrl` - string, the URL the user should visit to authorize (only present when running)\n\n' +
      'This is a newer endpoint (landing in rclone v1.75, currently unreleased)\n' +
      'that enables in-process OAuth without spawning a separate `rclone authorize`\n' +
      'subprocess. Used by the librclone transport for OAuth flows on mobile.',
  },
  'config/oauthstop': {
    const: 'OAUTHSTOP',
    title: 'Stop the currently running OAuth auth server.',
    help:
      'No parameters. Returns `{}`.\n\n' +
      'Cancels an in-progress OAuth flow. Used by the mobile OAuth UI to let\n' +
      'the user cancel a stuck auth flow. Counterpart to `config/oauthstatus`.',
  },
};

// Endpoints we strip by default — internal test/no-op commands that aren't
// useful in a typed client. Override with --include-internal.
const INTERNAL_DENYLIST = new Set([
  // (none denied by default — emit everything rc/list returns)
]);

// ---- arg parsing ----------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    extras: DEFAULT_EXTRAS,
    noExtras: false,
    live: false,
    url: DEFAULT_RCLONE_URL,
    includeInternal: false,
    previous: null,
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
      case '--extras':
        opts.extras = argv[++i];
        break;
      case '--no-extras':
        opts.noExtras = true;
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
      case '--previous':
        opts.previous = argv[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`update-endpoints.cjs — regenerate endpoints.rs from rclone rc/list

Usage:
  node update-endpoints.cjs [--input rc.json] [--output endpoints.rs]
                            [--extras extras.json | --no-extras]
                            [--previous old_endpoints.rs]
                            [--live [--url http://127.0.0.1:5572]]
                            [--include-internal]

If --live is given, --input is ignored and the script calls
'rclone rc rc/list' against the given --url.`);
}

// ---- data sources ---------------------------------------------------------
function loadFromJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function loadFromLive(url) {
  console.log(`Fetching rc/list from ${url}...`);
  const result = spawnSync('rclone', ['rc', 'rc/list', '--rc-no-auth', '--url', url], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(`rclone rc failed (status ${result.status}): ${result.stderr}`);
    console.error("Ensure rclone rcd is running, e.g. 'rclone rcd --rc-no-auth --rc-addr :5572'.");
    process.exit(1);
  }
  return JSON.parse(result.stdout);
}

// ---- helpers --------------------------------------------------------------
/**
 * Convert "core/bwlimit" -> "BWLIMIT"
 *        "config/oauth-status" -> "OAUTH_STATUS"
 *        "rc/noopauth" -> "NOOPAUTH"
 */
function pathToConstName(fullPath) {
  const slashIdx = fullPath.indexOf('/');
  if (slashIdx === -1) return scream(fullPath);
  const rest = fullPath.slice(slashIdx + 1);
  return scream(rest);
}

function scream(s) {
  // Split on hyphens and underscores, then upper-case and join with underscores.
  return s
    .split(/[-_]/)
    .map(p => p.toUpperCase())
    .join('_');
}

/**
 * Group commands by their first path segment.
 * Returns: { core: [...], config: [...], ... }
 */
function groupCommands(commands) {
  const groups = {};
  for (const cmd of commands) {
    const slashIdx = cmd.Path.indexOf('/');
    const group = slashIdx === -1 ? cmd.Path : cmd.Path.slice(0, slashIdx);
    if (!groups[group]) groups[group] = [];
    groups[group].push(cmd);
  }
  // Sort within each group by path
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => a.Path.localeCompare(b.Path));
  }
  return groups;
}

/**
 * Convert rclone rc help text into Rust doc-comment lines, indented.
 * - Each line gets a "/// " prefix (with the indent applied).
 * - Empty lines become "///".
 * - Tabs are expanded to 4 spaces (avoids clippy::tabs_in_doc_comments).
 * - Markdown list-item continuation lines are indented by 2 extra spaces
 *   (avoids clippy::doc_lazy_continuation).
 * - Trailing whitespace (markdown hard breaks) is stripped.
 * - Indent is the leading whitespace to put on each line (e.g. "    " for nested).
 */
function docLines(text, indent) {
  // 1. Normalise newlines and expand tabs to 4 spaces (clippy::tabs_in_doc_comments).
  //    Using a fixed 4-space expansion keeps code examples aligned with the
  //    `/// ` prefix that Rust doc comments add.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\t/g, '    ');
  const rawLines = normalized.split('\n');

  // 2. Strip trailing whitespace (cosmetic — rclone uses 2 trailing spaces as
  //    markdown hard breaks; we don't need them in doc comments).
  const stripped = rawLines.map(l => l.replace(/\s+$/, ''));

  // 3. Indent continuation lines of markdown list items by 2 spaces so clippy
  //    doesn't flag them as doc_lazy_continuation. A list item is any line
  //    whose trimmed form starts with "- " or "* " (after optional leading
  //    spaces). Continuation lines are non-blank lines that follow a list
  //    item without themselves being a new list item or a blank line.
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

/**
 * Build a single `pub const NAME: &str = "...";` block with doc comments
 * derived from the command's Title + Help.
 * If isNew is true, wraps the const line in the "New Key" marker block
 * (matching the convention used by update-flags.cjs).
 */
function renderConst(cmd, indent, isNew) {
  const ind = indent; // e.g. "    " (4 spaces)
  const lines = [];
  // Title as a one-line summary
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
    // Marker style matching update-flags.cjs
    lines.push(`${ind}/////////////////////////////////////// New Key start`);
    lines.push(constLine);
    lines.push(`${ind}////////////////////////////////////// New key end`);
  } else {
    lines.push(constLine);
  }
  return lines.join('\n');
}

/**
 * Build a `pub mod <name> { ... }` block.
 */
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

/**
 * Parse an existing endpoints.rs file and return the set of paths that are
 * already declared (uncommented). Used to decide which new entries to mark.
 */
function parseExistingPaths(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return new Set();
  const src = fs.readFileSync(filePath, 'utf8');
  const out = new Set();
  const re = /^\s*pub const\s+\w+\s*:\s*&str\s*=\s*"([^"]+)"/;
  for (const line of src.split('\n')) {
    if (/^\s*\/\//.test(line)) continue; // skip commented-out lines
    const m = re.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

// ---- main -----------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 1. Load rc data
  let rcData;
  if (opts.live) {
    rcData = loadFromLive(opts.url);
  } else {
    if (!fs.existsSync(opts.input)) {
      console.error(`Input file not found: ${opts.input}`);
      process.exit(1);
    }
    console.log(`Reading ${opts.input}...`);
    rcData = loadFromJson(opts.input);
  }
  const commands = rcData.commands || [];
  if (commands.length === 0) {
    console.error('No commands found in input.');
    process.exit(1);
  }

  // 2. Filter internal endpoints unless requested
  const filtered = commands.filter(c => {
    const denied = INTERNAL_DENYLIST.has(c.Path);
    return opts.includeInternal || !denied;
  });

  // 3. Merge in extras (custom additions)
  let extras = {};
  if (!opts.noExtras) {
    if (opts.extras && fs.existsSync(opts.extras)) {
      extras = JSON.parse(fs.readFileSync(opts.extras, 'utf8'));
    } else {
      extras = DEFAULT_EXTRA_ENDPOINTS;
    }
  }
  const merged = filtered.slice();
  for (const [p, info] of Object.entries(extras)) {
    if (!merged.find(c => c.Path === p)) {
      merged.push({
        Path: p,
        Title: info.title,
        Help: info.help,
        _extra: true,
      });
    }
  }

  // 4. Annotate each command with its const name
  for (const c of merged) {
    if (extras[c.Path]) {
      c.constName = extras[c.Path].const;
    } else {
      c.constName = pathToConstName(c.Path);
    }
  }

  // 5. Group
  const groups = groupCommands(merged);

  // 6. Determine "new" set (paths not present in previous file)
  const existingPaths = parseExistingPaths(opts.previous || opts.output);
  const isNewSet = new Set();
  for (const c of merged) {
    if (!existingPaths.has(c.Path)) isNewSet.add(c.Path);
  }
  console.log(`Total commands: ${merged.length}; new since previous: ${isNewSet.size}`);

  // 7. Order modules
  const ordered = Object.keys(groups).sort((a, b) => {
    const ia = MODULE_ORDER.indexOf(a);
    const ib = MODULE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  // 8. Render
  const header = [
    '// Rclone Remote Control (RC) API endpoints',
    '//',
    '// This module provides organized access to all rclone RC API endpoints.',
    '// The endpoints are categorized for easier management and discovery.',
    '//',
    `// Generated by update-endpoints.cjs from ${opts.live ? 'live rclone rc/list' : path.basename(opts.input)}.`,
    `// Total: ${merged.length} endpoints across ${ordered.length} modules.`,
    '//',
    '// To regenerate:',
    '//   node scripts/update-endpoints.cjs --input upload/rc.json --output src-tauri/src/utils/rclone/endpoints.rs',
    '//   node scripts/update-endpoints.cjs --live --url http://127.0.0.1:5572',
    '',
  ].join('\n');

  const body = ordered.map(name => renderModule(name, groups[name], isNewSet)).join('\n\n');
  const out = header + body + '\n';

  // 9. Write
  const outDir = path.dirname(opts.output);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(opts.output, out, 'utf8');
  console.log(`Wrote ${opts.output} (${merged.length} endpoints in ${ordered.length} modules).`);

  // 10. Quick summary
  for (const name of ordered) {
    console.log(`  - ${name}: ${groups[name].length}`);
  }
}

if (require.main === module) {
  main();
}
