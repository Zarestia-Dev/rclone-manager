# Maintainer: Hakan İSMAİL <hakanismail53@gmail.com>
pkgname=rclone-manager
appname='RClone.Manager'
releasetag=0.3.0
pkgver=0.3.0
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
sha256sums_x86_64=('1ad0ed456172c0f4fa6056122a672baca87e47b2aa8f7fbf62db30e53f7b3aa9')
sha256sums_aarch64=('e5b6bea2143d0a12b601ff606eba85011e070f550e734c5fc679abfa56e2217f')
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
  gtk-update-icon-cache -q -t -f usr/share/icons/hicolor 2>/dev/null || true
  update-desktop-database -q 2>/dev/null || true

  # Clean up user context menu registrations
  for user_home in /root /home/*; do
    if [ -d "$user_home" ]; then
      # Nautilus scripts
      rm -f "$user_home/.local/share/nautilus/scripts/"*" (RClone Manager)"
      # Nautilus Python extensions
      rm -f "$user_home/.local/share/nautilus-python/extensions/"*"_rclone_manager.py"
      # Dolphin service menus
      rm -f "$user_home/.local/share/kio/servicemenus/"*" (RClone Manager).desktop"
      # Nemo actions
      rm -f "$user_home/.local/share/nemo/actions/"*" (RClone Manager).nemo_action"
    fi
  done
}
