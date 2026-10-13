#!/usr/bin/env node
const path = require('node:path');
const { run, logError } = require('@tauri-apps/cli');
const root = path.resolve(__dirname, '..');
process.env.TAURI_APP_PATH = path.join(root, 'backend', 'desktop');
process.env.TAURI_FRONTEND_PATH = root;
process.chdir(root);
run(process.argv.slice(2), 'npm run tauri').catch(error => {
  logError(error.message || String(error));
  process.exitCode = 1;
});
