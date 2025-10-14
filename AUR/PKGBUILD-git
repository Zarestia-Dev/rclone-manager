# Maintainer: Hakan İSMAİL <hakanismail53@gmail.com>
pkgname=rclone-manager-git
appname='Rclone.Manager'
pkgver=0.1.4
pkgrel=2
pkgdesc="User-friendly GUI for Rclone"
arch=('x86_64' 'aarch64')
url="https://github.com/RClone-Manager/rclone-manager"
license=('GPL-3.0-or-later')
depends=('cairo' 'desktop-file-utils' 'gdk-pixbuf2' 'glib2' 'gtk3' 'hicolor-icon-theme' 'libsoup' 'pango' 'webkit2gtk-4.1' 'rclone')
makedepends=('git' 'openssl' 'appmenu-gtk-module' 'libappindicator-gtk3' 'librsvg' 'cargo' 'npm' 'nodejs')
optdepends=('7zip: Encrypt/decrypt backup data')
options=('!strip' '!debug')
provides=('rclone-manager')
conflicts=('rclone-manager')
# install=${pkgname}.install
source=("git+${url}.git")
sha256sums=('SKIP')

pkgver() {
  cd rclone-manager
  ( set -o pipefail
    git describe --long --abbrev=7 2>/dev/null | sed 's/\([^-]*-g\)/r\1/;s/-/./g' ||
    printf "r%s.%s" "$(git rev-list --count HEAD)" "$(git rev-parse --short=7 HEAD)"
  )
}

prepare() {
  cd rclone-manager
  npm install
}

build() {
  cd rclone-manager
  npm run tauri build -- --bundles deb -- --no-default-features --features arch
}

package() {
  cp -a rclone-manager/src-tauri/target/release/bundle/deb/rclone-manager_${pkgver}_*/data/* "${pkgdir}"
}

post_install() {
  gtk-update-icon-cache -q -t -f usr/share/icons/hicolor
  update-desktop-database -q
}

post_upgrade() {
  post_install
}

post_remove() {
  gtk-update-icon-cache -q -t -f usr/share/icons/hicolor
  update-desktop-database -q
}