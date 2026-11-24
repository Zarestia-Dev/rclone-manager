#!/bin/sh
# Removes what postinstall.sh linked and the file manager and start-at-login
# entries the app created for each user, under its name and the RClone Manager
# Headless name it replaced, only when the package goes away: DEB passes "remove"
# or "purge", RPM passes 0, and pacman, which runs it only on removal, the
# removed version.
case "$1" in
    remove | purge | 0 | *.*) ;;
    *) exit 0 ;;
esac
for name in rclone-manager-headless rclone-manager-headless-bin; do
    if [ "$(readlink "/usr/bin/$name")" = /usr/lib/rclone-manager-server/rclone-manager-headless ]; then
        rm -f "/usr/bin/$name"
    fi
done
for home in /root /home/*; do
    for product in "RClone Manager Server" "RClone Manager Headless"; do
        rm -f "$home/.local/share/nautilus/scripts/"*" ($product)" \
            "$home/.local/share/nautilus-python/extensions/"*" ($product).py" \
            "$home/.local/share/kio/servicemenus/"*" ($product).desktop" \
            "$home/.local/share/nemo/actions/"*" ($product).nemo_action" \
            "$home/.config/autostart/$product.desktop"
    done
done
exit 0
