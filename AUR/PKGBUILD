# Maintainer: Hakan İSMAİL <hakanismail53@gmail.com>
pkgname=rclone-manager
appname='Rclone.Manager'
releasetag=0.1.7
pkgver=0.1.7
pkgrel=1
pkgdesc="User-friendly GUI for Rclone"
arch=('x86_64' 'aarch64')
url="https://github.com/Zarestia-Dev/rclone-manager"
license=('GPL-3.0-or-later')
depends=('cairo' 'desktop-file-utils' 'gdk-pixbuf2' 'glib2' 'gtk3' 'hicolor-icon-theme' 'libsoup' 'pango' 'webkit2gtk-4.1' 'rclone')
optdepends=('7zip: Encrypt/decrypt backup data')
options=('!strip' '!debug')
# install=${pkgname}.install
source_x86_64=("${url}/releases/download/v${releasetag}/${appname}_${pkgver}_amd64.deb")
source_aarch64=("${url}/releases/download/v${releasetag}/${appname}_${pkgver}_arm64.deb")
sha256sums_x86_64=('SKIP')
sha256sums_aarch64=('SKIP')
package() {
  tar -xvf data.tar.gz -C "${pkgdir}"
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