#!/bin/sh
# DEB postinst and RPM %posttrans: both run after the RClone Manager Headless
# package this one replaces has been removed (an RPM's %preun of it runs after
# this package's files are in place). See legacy-launcher.sh.
for name in rclone-manager-headless rclone-manager-headless-bin; do
    ln -sfn /usr/lib/rclone-manager-server/rclone-manager-headless "/usr/bin/$name"
done
exit 0
