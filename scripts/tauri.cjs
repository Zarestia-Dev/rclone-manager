#!/usr/bin/env node
const path = require('node:path');
const { run, logError } = require('@tauri-apps/cli');
const { androidBuildArgs } = require('./release-version.cjs');
const root = path.resolve(__dirname, '..');
process.env.TAURI_APP_PATH = path.join(root, 'backend', 'desktop');
process.env.TAURI_FRONTEND_PATH = root;
process.chdir(root);
try {
  run(androidBuildArgs(process.argv.slice(2), process.env.TAURI_APP_PATH), 'npm run tauri').catch(
    error => {
      logError(error.message || String(error));
      process.exitCode = 1;
    }
  );
} catch (error) {
  logError(error.message || String(error));
  process.exitCode = 1;
}
