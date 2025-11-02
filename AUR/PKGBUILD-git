# Maintainer: Hakan İSMAİL <hakanismail53@gmail.com>
pkgname=rclone-manager-git
appname='Rclone.Manager'
pkgver=0.1.6  # Set initial value, will be overwritten by pkgver()
pkgrel=1
pkgdesc="User-friendly GUI for Rclone"
arch=('x86_64' 'aarch64')
url="https://github.com/Zarestia-Dev/rclone-manager"
license=('GPL-3.0-or-later')
depends=('cairo' 'desktop-file-utils' 'gdk-pixbuf2' 'glib2' 'gtk3' 'hicolor-icon-theme' 'libsoup' 'pango' 'webkit2gtk-4.1' 'rclone')
makedepends=('git' 'openssl' 'appmenu-gtk-module' 'libappindicator-gtk3' 'librsvg' 'cargo' 'npm' 'nodejs' 'pkg-config' 'zstd' 'xz' 'clang' 'lld' 'nss' 'nspr')
optdepends=('7zip: Encrypt/decrypt backup data')
options=('!strip' '!debug')
provides=('rclone-manager')
conflicts=('rclone-manager')
# install=${pkgname}.install
source=("git+${url}.git")
sha256sums=('SKIP')

pkgver() {
  cd rclone-manager
  git describe --long --tags | sed 's/^v//;s/\([^-]*-\)g/r\1/;s/-/./g'
}

prepare() {
  cd rclone-manager
  npm install
}

build() {
  cd rclone-manager
  
  # Set up environment for proper linking
  export CC=clang
  export CXX=clang++
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=clang
  export RUSTFLAGS="-C linker=clang -C link-arg=-fuse-ld=lld -C target-cpu=native"
  
  # Ensure pkg-config can find all libraries
  export PKG_CONFIG_PATH="/usr/lib/pkgconfig:/usr/share/pkgconfig"
  
  npm run tauri build -- --bundles deb --config '{"bundle":{"createUpdaterArtifacts":false}}' --features arch
}

package() {
  cd rclone-manager/src-tauri/target/release/bundle/deb/
  
  # Find the actual deb file
  DEB_FILE=$(ls *.deb | head -1)
  
  # Create temporary extraction directory
  local extracted_dir="${srcdir}/extracted"
  mkdir -p "${extracted_dir}"
  
  # Extract the deb package
  ar -x "${DEB_FILE}" --output "${extracted_dir}"
  tar -xz -C "${extracted_dir}" -f "${extracted_dir}/data.tar.gz"
 
  # Copy the entire usr directory structure
  cp -r "${extracted_dir}/usr" "${pkgdir}/"

  # Clean up
  rm -rf "${extracted_dir}"
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