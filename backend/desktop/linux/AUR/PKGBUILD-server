# Maintainer: Hakan İSMAİL <hakanismail53@gmail.com>
# Pure web server build: no GTK, WebKit, tray or X11 libraries.
pkgname=rclone-manager-server
releasetag=0.3.4
pkgver=0.3.4
pkgrel=1
pkgdesc="Manage Rclone from your browser (pure web server, no GUI libraries)"
arch=('x86_64' 'aarch64')
url="https://github.com/Zarestia-Dev/rclone-manager"
license=('GPL-3.0-or-later')
depends=('glibc' 'gcc-libs' 'dbus')
optdepends=('rclone: for cloud storage operations'
            'fuse3: for mounting remote filesystems')
options=('!strip' '!debug')
source_x86_64=("${url}/releases/download/headless-v${releasetag}/server-linux-x86_64-${pkgver}.zip")
source_aarch64=("${url}/releases/download/headless-v${releasetag}/server-linux-aarch64-${pkgver}.zip")
sha256sums_x86_64=('2c4526d2f93fb5861d423ae3136d6f4e60a0d93b2d3cdda5c373ca41d2251135')
sha256sums_aarch64=('89b872e4588ba9099e940a3e828522570f75a9a4b16e82c2fef58d8e7136ed84')

package() {
  cd "${srcdir}/rclone-manager-server"

  install -Dm755 rclone-manager-server "${pkgdir}/usr/bin/rclone-manager-server"
  install -Dm644 LICENSE "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"

  # Reuse the upstream unit, minus its manual /opt install notes, pointing at the packaged binary.
  sed -e '1,/^$/d' \
      -e 's|/opt/rclone-manager/rclone-manager-server|/usr/bin/rclone-manager-server|' \
      rclone-manager-server.service > unit.service
  grep -q '^ExecStart=/usr/bin/rclone-manager-server' unit.service
  install -Dm644 unit.service "${pkgdir}/usr/lib/systemd/system/rclone-manager-server.service"

  # Service account and its state directory, created by pacman's systemd hooks.
  install -dm755 "${pkgdir}/usr/lib/sysusers.d" "${pkgdir}/usr/lib/tmpfiles.d"
  echo 'u rclone-manager - "RClone Manager Server" /var/lib/rclone-manager /usr/bin/nologin' \
    > "${pkgdir}/usr/lib/sysusers.d/${pkgname}.conf"
  echo 'd /var/lib/rclone-manager 0750 rclone-manager rclone-manager -' \
    > "${pkgdir}/usr/lib/tmpfiles.d/${pkgname}.conf"
}
