#!/bin/sh
# Installed as /usr/lib/rclone-manager-server/rclone-manager-headless, and linked
# from /usr/bin/rclone-manager-headless and /usr/bin/rclone-manager-headless-bin by
# postinstall.sh. The RClone Manager Headless app (0.3.6 and older) ran from those
# paths: its restart after an update, its start-at-login entry and its file manager
# entries still call them, the start-at-login entry with a --tray that the server
# does not take. The server moves those entries to its own name on its first start.
for argument do
    shift
    [ "$argument" = --tray ] || set -- "$@" "$argument"
done
exec /usr/bin/rclone-manager-server "$@"
