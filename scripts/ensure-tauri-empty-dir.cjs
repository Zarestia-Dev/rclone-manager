const fs = require('fs');

// Ensure Tauri headless frontendDist placeholder exists.
fs.mkdirSync('backend/desktop/empty', { recursive: true });
