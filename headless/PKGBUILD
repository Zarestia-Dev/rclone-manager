# Maintainer: Hakan İSMAİL <hakanismail53@gmail.com>
pkgname=rclone-manager-headless
appname='RClone.Manager.Headless'
releasetag=0.1.8
pkgver=0.1.8
pkgrel=3
pkgdesc="User-friendly WebUI for Rclone (Headless Server)"
arch=('x86_64' 'aarch64')
url="https://github.com/Zarestia-Dev/rclone-manager"
license=('GPL-3.0-or-later')
depends=('cairo' 'desktop-file-utils' 'gdk-pixbuf2' 'glib2' 'gtk3' 'hicolor-icon-theme' 'libsoup' 'pango' 'webkit2gtk-4.1' 'rclone' 'xorg-server-xvfb' 'xorg-xset' 'dbus')
optdepends=('7zip: Encrypt/decrypt backup data')
options=('!strip' '!debug')
source_x86_64=("${url}/releases/download/headless-v${releasetag}/${appname}_${pkgver}_amd64.deb")
source_aarch64=("${url}/releases/download/headless-v${releasetag}/${appname}_${pkgver}_arm64.deb")
sha256sums_x86_64=('SKIP')
sha256sums_aarch64=('SKIP')

prepare() {
  cd "${srcdir}"
  
  # Extract the .deb package
  if [ -f "${appname}_${pkgver}_amd64.deb" ]; then
    ar x "${appname}_${pkgver}_amd64.deb"
  elif [ -f "${appname}_${pkgver}_arm64.deb" ]; then
    ar x "${appname}_${pkgver}_arm64.deb"
  fi
}

package() {
  cd "${srcdir}"
  
  # Robust extraction for different compression types used in .deb files
  if [ -f "data.tar.gz" ]; then
    tar -xf data.tar.gz -C "${pkgdir}"
  elif [ -f "data.tar.xz" ]; then
    tar -xf data.tar.xz -C "${pkgdir}"
  elif [ -f "data.tar.zst" ]; then
    tar -xf data.tar.zst -C "${pkgdir}"
  else
    msg "Error: data.tar archive not found inside deb package."
    return 1
  fi
  
  # Fix permissions
  find "${pkgdir}" -type d -exec chmod 755 {} \;
  find "${pkgdir}/usr/bin" -type f -exec chmod 755 {} \; 2>/dev/null || true
  
  # Create wrapper script during package build
  BIN_DIR="${pkgdir}/usr/bin"
  
  # Rename the actual binary to -bin suffix
  if [ -f "$BIN_DIR/rclone-manager-headless" ]; then
    mv "$BIN_DIR/rclone-manager-headless" "$BIN_DIR/rclone-manager-headless-bin"
  fi

  # Create wrapper script
  cat > "$BIN_DIR/rclone-manager-headless" << 'WRAPPER_EOF'
#!/bin/bash
# RClone Manager Headless Launcher Script

set -e

BINARY_NAME="rclone-manager-headless-bin"
BINARY_PATH="/usr/bin/$BINARY_NAME"

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
        Xvfb $DISPLAY -screen 0 1024x768x24 -nolisten tcp &
        XVFB_PID=$!
        sleep 2
        if ! ps -p $XVFB_PID > /dev/null 2>&1; then
            echo "Error: Failed to start Xvfb" >&2
            exit 1
        fi
    fi
fi

if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
    if command -v dbus-launch &> /dev/null; then
        eval $(dbus-launch --sh-syntax)
        export DBUS_SESSION_BUS_ADDRESS
        export DBUS_SESSION_BUS_PID
    fi
fi

exec "$BINARY_PATH" "$@"
WRAPPER_EOF

  chmod +x "$BIN_DIR/rclone-manager-headless"
}

post_install() {
  # Update icon cache and desktop database
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
  update-desktop-database -q 2>/dev/null || true
  
  echo ""
  echo "==> RClone Manager Headless installed successfully!"
  echo "==> Run 'rclone-manager-headless --help' to get started."
  echo "==> Example: rclone-manager-headless --host 0.0.0.0 --port 8080"
  echo ""
}

post_upgrade() {
  post_install
}

post_remove() {
  # Update icon cache and desktop database
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
  update-desktop-database -q 2>/dev/null || true
}
