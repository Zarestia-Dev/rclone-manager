# Maintainer: Hakan İSMAİL <hakanismail53@gmail.com>
pkgname=rclone-manager
appname='RClone.Manager'
releasetag=0.2.8
pkgver=0.2.8
pkgrel=1
pkgdesc="User-friendly GUI for Rclone"
arch=('x86_64' 'aarch64')
url="https://github.com/Zarestia-Dev/rclone-manager"
license=('GPL-3.0-or-later')
depends=('cairo' 'desktop-file-utils' 'gdk-pixbuf2' 'glib2' 'gtk3' 'hicolor-icon-theme' 'pango' 'webkit2gtk-4.1' 'libayatana-appindicator')
optdepends=('rclone: for cloud storage operations', 'fuse3: for mounting remote filesystems')
options=('!strip' '!debug')
# install=${pkgname}.install
source_x86_64=("${url}/releases/download/v${releasetag}/${appname}_${pkgver}_amd64.deb")
source_aarch64=("${url}/releases/download/v${releasetag}/${appname}_${pkgver}_arm64.deb")
sha256sums_x86_64=('9a79f435c8f336c5e526f56dac4aaf636bfba48813935a069d2966bd2b4e94b2')
sha256sums_aarch64=('f80bb4fe80fb7912112a7b7a098c32931bffbdec73837cdbb831f962a3945573')
package() {
  tar -xvf data.tar.gz -C "${pkgdir}"
  rm -f "${pkgdir}/usr/share/flatpak.metainfo.xml"
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
