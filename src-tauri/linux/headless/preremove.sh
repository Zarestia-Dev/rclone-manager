#!/bin/bash
# Pre-remove script for RClone Manager Headless (DEB)

set -e

BIN_DIR="/usr/bin"

# Remove wrapper script
rm -f "$BIN_DIR/rclone-manager-headless"

# Rename the binary back
if [ -f "$BIN_DIR/rclone-manager-headless-bin" ]; then
    mv "$BIN_DIR/rclone-manager-headless-bin" "$BIN_DIR/rclone-manager-headless"
fi

exit 0
