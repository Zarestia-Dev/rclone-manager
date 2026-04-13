const fs = require('fs');
const path = require('path');

/**
 * Script to fix SVG Internal ID collisions.
 * 
 * When <mat-icon> renders SVGs inline, internal IDs (like id="a") can collide,
 * causing the browser to apply incorrect gradients or colors from other icons.
 * 
 * This script namespaces all IDs based on the filename to ensure uniqueness.
 */

const targetDir = path.join(__dirname, '../src/assets/icons');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else if (file.endsWith('.svg')) {
      results.push(file);
    }
  });
  return results;
}

const files = walk(targetDir);
let changedFiles = 0;

files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  const basename = path.basename(file, '.svg').replace(/[^a-zA-Z0-9]/g, '_');

  // Find all IDs
  const idRegex = /(?:\s)id="([^"]+)"/g;
  let match;
  const ids = new Set();
  while ((match = idRegex.exec(content)) !== null) {
    ids.add(match[1]);
  }

  if (ids.size > 0) {
    let newContent = content;
    ids.forEach(id => {
      // Avoid double processing if already prefixed
      if (!id.startsWith(basename + '_')) {
        const newId = `${basename}_${id}`;
        // Replace id="old_id"
        const replaceIdRegex = new RegExp(`(?<=\\s)id="${id}"`, 'g');
        newContent = newContent.replace(replaceIdRegex, `id="${newId}"`);

        // Replace url(#old_id)
        const replaceUrlRegex = new RegExp(`url\\(#${id}\\)`, 'g');
        newContent = newContent.replace(replaceUrlRegex, `url(#${newId})`);

        // Replace href="#old_id" (both href and xlink:href)
        const replaceHrefRegex = new RegExp(`href="#${id}"`, 'g');
        newContent = newContent.replace(replaceHrefRegex, `href="#${newId}"`);
      }
    });

    if (newContent !== content) {
      fs.writeFileSync(file, newContent, 'utf8');
      changedFiles++;
    }
  }
});

console.log(`Processed ${files.length} files. Modified ${changedFiles} files with unique SVG internal IDs.`);
