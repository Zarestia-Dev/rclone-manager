# Maintainer: Hakan İSMAİL <hakanismail53@gmail.com>
pkgname=rclone-manager
appname='RClone.Manager'
releasetag=0.2.9
pkgver=0.2.9
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
sha256sums_x86_64=('19683196a1ff0b01f02f48b9b29fefce8326225ae690d7cb59896ed25b4b9b2f')
sha256sums_aarch64=('f7a8bbb53f5cdf616eceb3daf89697c4ca180b5872bff1edc8fa1a7930c68f09')
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
