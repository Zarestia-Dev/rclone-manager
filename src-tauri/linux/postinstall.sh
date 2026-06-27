#!/bin/bash
# Post-install script for RClone Manager Headless (DEB)

set -e

BIN_DIR="/usr/bin"

# Rename the actual binary to -bin suffix
if [ -f "$BIN_DIR/rclone-manager-headless" ] && [ ! -L "$BIN_DIR/rclone-manager-headless" ]; then
    mv "$BIN_DIR/rclone-manager-headless" "$BIN_DIR/rclone-manager-headless-bin"
fi

# Create wrapper script
cat > "$BIN_DIR/rclone-manager-headless" << 'WRAPPER_EOF'
#!/bin/bash
# RClone Manager Headless Launcher Script

set -e

BINARY_NAME="rclone-manager-headless-bin"
BINARY_PATH="/usr/bin/$BINARY_NAME"

# --- Disable Hardware Acceleration for Headless WebKit ---
export WEBKIT_DISABLE_COMPOSITING_MODE=1

needs_xvfb() {
    if [ -z "$DISPLAY" ] || ! xset q &>/dev/null 2>&1; then
        return 0
    fi
    return 1
}

find_available_display() {
    local display_num=99
    while [ -e "/tmp/.X${display_num}-lock" ] || [ -e "/tmp/.X11-unix/X${display_num}" ]; do
        display_num=$((display_num + 1))
    done
    echo $display_num
}

cleanup() {
    # Kill Xvfb and DBus if we started them
    if [ ! -z "$XVFB_PID" ] && ps -p $XVFB_PID > /dev/null 2>&1; then
        kill $XVFB_PID 2>/dev/null || true
    fi
    if [ ! -z "$DBUS_SESSION_BUS_PID" ] && ps -p $DBUS_SESSION_BUS_PID > /dev/null 2>&1; then
        kill $DBUS_SESSION_BUS_PID 2>/dev/null || true
    fi
}

trap cleanup EXIT INT TERM

if needs_xvfb; then
    if command -v Xvfb &> /dev/null; then
        DISPLAY_NUM=$(find_available_display)
        export DISPLAY=":$DISPLAY_NUM"
        rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true
        
        # Start Xvfb
        # Redirect stderr to /dev/null to hide the noisy xkbcomp warnings if you prefer
        Xvfb $DISPLAY -screen 0 1024x768x24 -nolisten tcp >/dev/null 2>&1 &
        XVFB_PID=$!
        sleep 2
        
        if ! ps -p $XVFB_PID > /dev/null 2>&1; then
            echo "Error: Failed to start Xvfb" >&2
            exit 1
        fi
        echo "Xvfb started on $DISPLAY"
    fi
fi

if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
    if command -v dbus-launch &> /dev/null; then
        eval $(dbus-launch --sh-syntax)
        export DBUS_SESSION_BUS_ADDRESS
        export DBUS_SESSION_BUS_PID
        echo "DBus session started"
    fi
fi

echo "Launching $BINARY_NAME..."
exec "$BINARY_PATH" "$@"
WRAPPER_EOF

chmod +x "$BIN_DIR/rclone-manager-headless"

echo "RClone Manager Headless installed successfully!"
echo "Run 'rclone-manager-headless --help' to get started."

exit 0
