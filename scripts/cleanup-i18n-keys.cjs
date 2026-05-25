#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const i18nRoot = path.join(repoRoot, 'resources', 'i18n');

// Read the unused.json to get the list of keys to remove
const unusedJsonPath = path.join(repoRoot, 'unused.json');
let fileContent = fs.readFileSync(unusedJsonPath, 'utf-8');

// Skip npm output header (first 2 lines)
const lines = fileContent.split('\n');
const jsonStart = lines.findIndex(line => line.trim().startsWith('{'));
fileContent = lines.slice(jsonStart).join('\n');

const unusedData = JSON.parse(fileContent);

// Function to remove keys from an object based on a flat key list
function removeKeys(obj, keysToRemove) {
  const keysSet = new Set(keysToRemove);
  
  function traverse(current, prefix = '') {
    const keys = Object.keys(current);
    
    for (const key of keys) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      
      if (keysSet.has(fullKey)) {
        delete current[key];
      } else if (typeof current[key] === 'object' && current[key] !== null && !Array.isArray(current[key])) {
        traverse(current[key], fullKey);
      }
    }
  }
  
  traverse(obj);
  return obj;
}

// Function to clean up empty objects after key removal
function cleanupEmptyObjects(obj) {
  const keys = Object.keys(obj);
  
  for (const key of keys) {
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      cleanupEmptyObjects(obj[key]);
      if (Object.keys(obj[key]).length === 0) {
        delete obj[key];
      }
    }
  }
  
  return obj;
}

// Process each locale
const locales = ['zh-CN', 'tr-TR', 'es-ES', 'en-US'];
let totalRemoved = 0;

for (const locale of locales) {
  if (!unusedData.locales[locale]) {
    console.log(`No data for locale: ${locale}`);
    continue;
  }
  
  const localeData = unusedData.locales[locale];
  const keysToRemove = [...(localeData.unused || []), ...(localeData.codeUnused || [])];
  
  if (keysToRemove.length === 0) {
    console.log(`No unused keys for locale: ${locale}`);
    continue;
  }
  
  // Process all JSON files in the locale directory
  const localeDir = path.join(i18nRoot, locale);
  const jsonFiles = fs.readdirSync(localeDir).filter(f => f.endsWith('.json'));
  
  for (const file of jsonFiles) {
    const filePath = path.join(localeDir, file);
    let content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const initialKeys = Object.keys(JSON.stringify(content)).length;
    
    content = removeKeys(content, keysToRemove);
    content = cleanupEmptyObjects(content);
    
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + '\n', 'utf-8');
    
    console.log(`✓ Cleaned ${file} for ${locale}`);
  }
  
  totalRemoved += keysToRemove.length;
}

console.log(`\n✨ Total keys removed: ${totalRemoved}`);
