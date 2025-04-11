import { Injectable } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { MatIconRegistry } from '@angular/material/icon';

@Injectable({
  providedIn: 'root'
})
export class IconService {

  constructor(private iconRegistry: MatIconRegistry, private sanitizer: DomSanitizer) {
    this.registerIcons();
  }

  private registerIcons(): void {
    const icons: Record<string, string> = {
      // Titlebar icons
      'add': 'assets/icons/titlebar/add.svg',
      'menu-bar': 'assets/icons/titlebar/menu-bar.svg',
      'remove': 'assets/icons/titlebar/remove.svg',
      'check_box': 'assets/icons/titlebar/check_box.svg',
      'close': 'assets/icons/titlebar/close.svg',
      'ellipsis-vertical': 'assets/icons/titlebar/ellipsis-vertical.svg',

      // App icons
      'mount': 'assets/icons/mount.svg',
      'vfs': 'assets/icons/vfs.svg',
      'sync': 'assets/icons/folder-sync.svg',
      'copy': 'assets/icons/copy.svg',
      'jobs': 'assets/icons/jobs.svg',
      'hard-drive': 'assets/icons/hard-drive.svg',
      'folder': 'assets/icons/folder.svg',
      'circle-exclamation': 'assets/icons/circle-exclamation.svg',
      'circle-xmark': 'assets/icons/circle-xmark.svg',
      'wrench': 'assets/icons/wrench.svg',
      'pen': 'assets/icons/pen.svg',
      'download': 'assets/icons/download.svg',
      'remotes': 'assets/icons/remotes.svg',
      'search': 'assets/icons/titlebar/search.svg',
      'puzzle-piece': 'assets/icons/puzzle-piece.svg',
      'flask': 'assets/icons/flask.svg',
      'question': 'assets/icons/question.svg',

      // Remote icons
      'drive': 'assets/icons/remotes/drive.svg',
      'dropbox': 'assets/icons/remotes/dropbox.svg',
      'ftp': 'assets/icons/remotes/ftp.svg',
      'onedrive': 'assets/icons/remotes/onedrive.svg',
      's3': 'assets/icons/remotes/s3.svg',

      // Theme icons
      'circle-check': 'assets/icons/circle-check.svg',

      // App icons
      'rclone-symbolic': 'assets/rclone-symbolic.svg',
      'rclone': 'assets/rclone.svg',
      'rclone-2': 'assets/rclone-2.svg',

      // Navigation icons
      'left-arrow': 'assets/icons/circle-arrow-left.svg',
      'right-arrow': 'assets/icons/circle-arrow-right.svg',
      'chevron-right': 'assets/icons/chevron-right.svg',
      'chevron-left': 'assets/icons/chevron-left.svg',
      'open-link': 'assets/icons/arrow-up-right-from-square.svg',

    };

    for (const [name, path] of Object.entries(icons)) {
      this.iconRegistry.addSvgIcon(name, this.sanitizer.bypassSecurityTrustResourceUrl(path));
    }
  }
}
