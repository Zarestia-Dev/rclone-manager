#!/usr/bin/env node
// `npm run dev:server`: what `tauri dev` does for the desktop app, for the server.
// It starts the Angular dev server (port 1420, proxies /api to the server) and the Rust
// server, and starts the server again whenever a Rust source or main.json translation of the backend changes.
// Arguments after `--` go to the server: `npm run dev:server -- --port 9090`.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const watched = [
  path.join(root, 'backend', 'core'),
  path.join(root, 'backend', 'server'),
  path.join(root, 'resources', 'i18n'),
];
// The server reads only main.json of a language (tray, notifications, backend errors).
const isSource = file => /\.(rs|toml)$/.test(file) || path.basename(file) === 'main.json';

const spawnOptions = { cwd: root, stdio: 'inherit' };
const stop = child => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    child.once('exit', resolve);
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  });
};

const frontend = spawn(
  process.execPath,
  [require.resolve('@angular/cli/bin/ng.js'), 'serve', '--configuration', 'headless'],
  spawnOptions
);

let server;
let starting = Promise.resolve();
let closing = false;

// One restart at a time: a change while the server is compiling replaces that build.
const restart = () => {
  starting = starting.then(async () => {
    if (closing) return;
    if (server) await stop(server);
    server = spawn(
      'cargo',
      [
        'run',
        '--manifest-path',
        'backend/Cargo.toml',
        '-p',
        'rclone-manager-server',
        '--',
        ...process.argv.slice(2),
      ],
      spawnOptions
    );
  });
};

let timer;
const onChange = (_event, file) => {
  if (!file || !isSource(file.toString())) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log('\n[dev:server] backend sources changed, restarting the server');
    restart();
  }, 300);
};
for (const directory of watched) {
  fs.watch(directory, { recursive: true }, onChange);
}
fs.watch(path.join(root, 'backend', 'Cargo.toml'), onChange);

const close = async code => {
  if (closing) return;
  closing = true;
  await Promise.all([stop(frontend), server ? stop(server) : undefined]);
  process.exit(code);
};
frontend.on('exit', code => close(code ?? 1));
process.on('SIGINT', () => close(0));
process.on('SIGTERM', () => close(0));

restart();
