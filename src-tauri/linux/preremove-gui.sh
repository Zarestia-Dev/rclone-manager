#!/bin/bash
# Pre-remove script for RClone Manager (DEB/RPM)

set -e

# Clean up user context menu registrations
for user_home in /root /home/*; do
    if [ -d "$user_home" ]; then
        # 1. Nautilus scripts
        rm -f "$user_home/.local/share/nautilus/scripts/"*" (RClone Manager)"
        
        # 2. Nautilus Python extensions
        rm -f "$user_home/.local/share/nautilus-python/extensions/"*"_rclone_manager.py"
        
        # 3. Dolphin service menus
        rm -f "$user_home/.local/share/kio/servicemenus/"*" (RClone Manager).desktop"
        
        # 4. Nemo actions
        rm -f "$user_home/.local/share/nemo/actions/"*" (RClone Manager).nemo_action"
    fi
done

exit 0
