#!/bin/bash

# Homebrew Cask Release Script for RClone Manager
# This script generates Homebrew cask files for both architectures

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
APP_NAME="rclone-manager"
AUTHOR="Zarestia-Dev"
REPO="rclone-manager"
BUNDLE_NAME="RClone Manager"

echo -e "${GREEN}=== Homebrew Cask Release Script ===${NC}"
echo -e "Version: ${YELLOW}${VERSION}${NC}"
echo ""

# Define paths
ARM64_DMG_PATH="./target/aarch64-apple-darwin/release/bundle/dmg/${BUNDLE_NAME}_${VERSION}_aarch64.dmg"
X64_DMG_PATH="./target/x86_64-apple-darwin/release/bundle/dmg/${BUNDLE_NAME}_${VERSION}_x64.dmg"
HOMEBREW_OUTPUT_DIR="./homebrew"
HOMEBREW_CASK_FILE="${HOMEBREW_OUTPUT_DIR}/rclone-manager.rb"
HOMEBREW_TEMPLATE_FILE="${HOMEBREW_OUTPUT_DIR}/rclone-manager.rb.template"

# Check if DMG files exist
echo -e "${GREEN}Checking for DMG files...${NC}"

if [ ! -f "$ARM64_DMG_PATH" ]; then
    echo -e "${RED}Error: ARM64 DMG not found at ${ARM64_DMG_PATH}${NC}"
    echo "Please build the ARM64 version first using: npm run tauri build -- --target aarch64-apple-darwin"
    exit 1
fi

if [ ! -f "$X64_DMG_PATH" ]; then
    echo -e "${RED}Error: x64 DMG not found at ${X64_DMG_PATH}${NC}"
    echo "Please build the x64 version first using: npm run tauri build -- --target x86_64-apple-darwin"
    exit 1
fi

echo -e "${GREEN}✓ ARM64 DMG found${NC}"
echo -e "${GREEN}✓ x64 DMG found${NC}"
echo ""

# Calculate SHA256 checksums
echo -e "${GREEN}Calculating SHA256 checksums...${NC}"
ARM64_SHA256=$(shasum -a 256 "$ARM64_DMG_PATH" | awk '{print $1}')
X64_SHA256=$(shasum -a 256 "$X64_DMG_PATH" | awk '{print $1}')

echo -e "ARM64 SHA256: ${YELLOW}${ARM64_SHA256}${NC}"
echo -e "x64 SHA256: ${YELLOW}${X64_SHA256}${NC}"
echo ""

# Create the Homebrew cask directories
mkdir -p "$HOMEBREW_OUTPUT_DIR"
mkdir -p "${HOMEBREW_OUTPUT_DIR}/casks"

# Check if template exists
if [ ! -f "$HOMEBREW_TEMPLATE_FILE" ]; then
    echo -e "${RED}Error: Template file not found at ${HOMEBREW_TEMPLATE_FILE}${NC}"
    exit 1
fi

# Generate the cask file from template
echo -e "${GREEN}Generating Homebrew cask file from template...${NC}"

# Read template and replace placeholders
CASK_CONTENT=$(sed "s/{{VERSION}}/${VERSION}/g" "$HOMEBREW_TEMPLATE_FILE")
CASK_CONTENT=$(echo "$CASK_CONTENT" | sed "s/{{ARM64_SHA256}}/${ARM64_SHA256}/g")
CASK_CONTENT=$(echo "$CASK_CONTENT" | sed "s/{{X64_SHA256}}/${X64_SHA256}/g")

# Write to main cask file
echo "$CASK_CONTENT" > "$HOMEBREW_CASK_FILE"

# Write versioned backup (with versioned cask name)
VERSIONED_CASK_FILE="${HOMEBREW_OUTPUT_DIR}/casks/rclone-manager-${VERSION}.rb"
VERSIONED_CASK_CONTENT=$(echo "$CASK_CONTENT" | sed "s/cask \"rclone-manager\"/cask \"rclone-manager@${VERSION}\"/")
echo "$VERSIONED_CASK_CONTENT" > "$VERSIONED_CASK_FILE"

echo -e "${GREEN}✓ Main cask file generated: ${HOMEBREW_CASK_FILE}${NC}"
echo -e "${GREEN}✓ Versioned backup created: ${VERSIONED_CASK_FILE}${NC}"
echo ""

# Create a checksum info file for reference
CHECKSUMS_FILE="${HOMEBREW_OUTPUT_DIR}/checksums.txt"
cat > "$CHECKSUMS_FILE" <<EOF
RClone Manager v${VERSION} Checksums
======================================

ARM64 (Apple Silicon):
  File: ${BUNDLE_NAME}_${VERSION}_aarch64.dmg
  SHA256: ${ARM64_SHA256}

Intel (x86_64):
  File: ${BUNDLE_NAME}_${VERSION}_x64.dmg
  SHA256: ${X64_SHA256}
EOF

echo -e "${GREEN}✓ Checksum file generated: ${CHECKSUMS_FILE}${NC}"
echo ""

# Display the cask file content
echo -e "${GREEN}=== Generated Cask File ===${NC}"
cat "$HOMEBREW_CASK_FILE"
echo ""

# List all historical cask versions
echo -e "${GREEN}=== Historical Cask Versions ===${NC}"
if [ -d "${HOMEBREW_OUTPUT_DIR}/casks" ] && [ -n "$(ls -A ${HOMEBREW_OUTPUT_DIR}/casks 2>/dev/null)" ]; then
    echo "Found $(ls -1 ${HOMEBREW_OUTPUT_DIR}/casks/*.rb 2>/dev/null | wc -l | tr -d ' ') versioned cask file(s):"
    ls -1t "${HOMEBREW_OUTPUT_DIR}/casks"/*.rb 2>/dev/null | while read -r file; do
        filename=$(basename "$file")
        version=$(echo "$filename" | sed 's/rclone-manager-\(.*\)\.rb/\1/')
        size=$(du -h "$file" | awk '{print $1}')
        echo -e "  ${YELLOW}• v${version}${NC} (${size})"
    done
else
    echo "  No historical cask files found"
fi
echo ""

# Instructions
echo -e "${GREEN}=== Next Steps ===${NC}"
echo ""
echo "1. Test the cask locally:"
echo -e "   ${YELLOW}brew install --cask --debug ${HOMEBREW_CASK_FILE}${NC}"
echo ""
echo "2. Upload DMG files to GitHub Releases:"
echo -e "   ${YELLOW}gh release create v${VERSION} \"${ARM64_DMG_PATH}\" \"${X64_DMG_PATH}\" --title \"v${VERSION}\" --notes \"Release v${VERSION}\"${NC}"
echo ""
echo "   Attach the checksums file for reference:"
echo -e "   ${YELLOW}gh release upload v${VERSION} ${CHECKSUMS_FILE}${NC}"
echo ""
echo "3. Copy the generated cask files to your homebrew tap repo:"
echo -e "   ${YELLOW}cp ${HOMEBREW_CASK_FILE} ../zarestia-homebrew/Casks/rclone-manager.rb${NC}"
echo -e "   ${YELLOW}cp ${VERSIONED_CASK_FILE} ../zarestia-homebrew/Casks/${NC}"
echo ""
echo "4. Audit and style check:"
echo -e "   ${YELLOW}brew audit --cask --online ${HOMEBREW_CASK_FILE}${NC}"
echo -e "   ${YELLOW}brew style --cask ${HOMEBREW_CASK_FILE}${NC}"
echo ""
echo -e "${GREEN}=== Script Complete ===${NC}"