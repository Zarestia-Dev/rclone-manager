# Maintainer: Hakan İSMAİL <hakanismail53@gmail.com>
pkgname=rclone-manager
appname='RClone.Manager'
releasetag=0.2.5
pkgver=0.2.5
pkgrel=1
pkgdesc="User-friendly GUI for Rclone"
arch=('x86_64' 'aarch64')
url="https://github.com/Zarestia-Dev/rclone-manager"
license=('GPL-3.0-or-later')
depends=('cairo' 'desktop-file-utils' 'gdk-pixbuf2' 'glib2' 'gtk3' 'hicolor-icon-theme' 'libsoup' 'pango' 'webkit2gtk-4.1' 'libayatana-appindicator')
optdepends=('rclone: for cloud storage operations', 'fuse3: for mounting remote filesystems')
options=('!strip' '!debug')
# install=${pkgname}.install
source_x86_64=("${url}/releases/download/v${releasetag}/${appname}_${pkgver}_amd64.deb")
source_aarch64=("${url}/releases/download/v${releasetag}/${appname}_${pkgver}_arm64.deb")
sha256sums_x86_64=('c83c5dbcf93ab6e28344ecad2220c29a665df648a552447e4f3f79425789b01f')
sha256sums_aarch64=('b425f9c88aad4b4816ff72ca629872e8c50d406b3c27e96639a0c6ca2c7acd55')
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