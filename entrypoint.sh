#!/bin/bash
set -e

# =============================================================================
# 1. User & Permission Setup
# =============================================================================
# Read requested UID/GID or default to 1000
PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Modify internal rclone-manager user to match the host UID/GID requested.
# The -o flag allows non-unique IDs to prevent crashes if the ID exists.
groupmod -o -g "$PGID" rclone-manager 2>/dev/null || true
usermod -o -u "$PUID" rclone-manager 2>/dev/null || true

# Ensure critical volumes and data directories have the correct ownership
# This step is crucial for persistent volumes spawned as root by Docker.
chown -R rclone-manager:rclone-manager /home/rclone-manager /app /data /config 2>/dev/null || true

# =============================================================================
# 2. Legacy Migration & Backward Compatibility (#158)
# =============================================================================
# Detect if user is using old v0.2.0 volume mappings (/home/rclone-manager/...)
# while the new /config or /data roots are empty.

LEGACY_CONFIG_DIR="/home/rclone-manager/.config/rclone"
LEGACY_DATA_DIR="/home/rclone-manager/.local/share/com.rclone.manager.headless"

# Only migrate if the user hasn't provided a custom path already
if [ "$RCLONE_CONFIG" = "/config/rclone.conf" ]; then
    if [ -d "$LEGACY_CONFIG_DIR" ] && [ -n "$(ls -A $LEGACY_CONFIG_DIR 2>/dev/null)" ] && [ ! -f "/config/rclone.conf" ]; then
        echo "📂 Legacy rclone config detected. Redirecting RCLONE_CONFIG..."
        export RCLONE_CONFIG="${LEGACY_CONFIG_DIR}/rclone.conf"
    fi
fi

# Only migrate data dir if it's still pointing to the default /data
if [ "$RCLONE_MANAGER_DATA_DIR" = "/data" ]; then
    if [ -d "$LEGACY_DATA_DIR" ] && [ -n "$(ls -A $LEGACY_DATA_DIR 2>/dev/null)" ] && [ -z "$(ls -A /data 2>/dev/null)" ]; then
        echo "📂 Legacy app data detected. Redirecting RCLONE_MANAGER_DATA_DIR..."
        export RCLONE_MANAGER_DATA_DIR="$LEGACY_DATA_DIR"
        export RCLONE_MANAGER_CACHE_DIR="${LEGACY_DATA_DIR}/cache"
    fi
fi

# =============================================================================
# 3. Runtime Rclone Provisioning
# =============================================================================
# Check if rclone exists in /data (either as 'rclone' or 'rclone-bin/rclone')
if [ -x "/data/rclone" ]; then
    RCLONE_BIN="/data/rclone"
else
    RCLONE_BIN="/data/rclone-bin/rclone"
fi

if [ ! -x "$RCLONE_BIN" ]; then
    ARCH=$(dpkg --print-architecture)
    
    # Map Debian architecture nomenclature to Rclone release architecture nomenclature
    case "$ARCH" in
        amd64) RCLONE_ARCH="amd64" ;;
        arm64) RCLONE_ARCH="arm64" ;;
        i386)  RCLONE_ARCH="386"   ;;
        armhf) RCLONE_ARCH="arm-v7" ;;
        *)     RCLONE_ARCH="$ARCH" ;;
    esac

    mkdir -p /data/rclone-bin /tmp/rclone-dl
    
    curl -sL -o /tmp/rclone-dl/rclone.zip \
        "https://downloads.rclone.org/rclone-current-linux-${RCLONE_ARCH}.zip"
    
    unzip -qo /tmp/rclone-dl/rclone.zip -d /tmp/rclone-dl
    
    cp /tmp/rclone-dl/rclone-*-linux-${RCLONE_ARCH}/rclone "/data/rclone-bin/rclone"
    chmod 755 "/data/rclone-bin/rclone"
    chown rclone-manager:rclone-manager "/data/rclone-bin/rclone"
    RCLONE_BIN="/data/rclone-bin/rclone"
    
    rm -rf /tmp/rclone-dl
fi

# Add the directory of the found/downloaded binary to PATH
RCLONE_DIR=$(dirname "$RCLONE_BIN")
export PATH="${RCLONE_DIR}:${PATH}"

# =============================================================================
# 4. Virtual Display Initialization
# =============================================================================
# Tauri heavily relies on GTK. Since we are in a headless environment container,
# we simulate a display environment using Xvfb (X virtual framebuffer) and dbus.
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp &
sleep 1
export $(dbus-launch)
export DISPLAY=:99

# =============================================================================
# 6. Command Argument Assembly
# =============================================================================
# Convert passed environment variables into the explicit CLI arg strings required
# by the backend binary.
ARGS=()
[ -n "$RCLONE_MANAGER_HOST" ] && ARGS+=("--host" "$RCLONE_MANAGER_HOST")
[ -n "$RCLONE_MANAGER_PORT" ] && ARGS+=("--port" "$RCLONE_MANAGER_PORT")
[ -n "$RCLONE_MANAGER_USER" ] && ARGS+=("--user" "$RCLONE_MANAGER_USER")
[ -n "$RCLONE_MANAGER_PASS" ] && ARGS+=("--pass" "$RCLONE_MANAGER_PASS")
[ -n "$RCLONE_MANAGER_TLS_CERT" ] && ARGS+=("--tls-cert" "$RCLONE_MANAGER_TLS_CERT")
[ -n "$RCLONE_MANAGER_TLS_KEY" ] && ARGS+=("--tls-key" "$RCLONE_MANAGER_TLS_KEY")

# =============================================================================
# 7. Handover
# =============================================================================
# Execute using gosu to securely drop privileges from root to rclone-manager.
# `exec` ensures the resulting process becomes PID 1 to gracefully receive
# termination signals issued by Docker stop commands.
exec gosu rclone-manager /usr/local/bin/rclone-manager-headless "${ARGS[@]}" "$@"