const fs = require('fs');

// Ensure Tauri headless frontendDist placeholder exists.
fs.mkdirSync('src-tauri/empty', { recursive: true });
