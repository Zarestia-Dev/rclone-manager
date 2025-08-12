import { inject, Injectable } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { MatIconRegistry } from '@angular/material/icon';

@Injectable({
  providedIn: 'root',
})
export class IconService {
  private iconRegistry = inject(MatIconRegistry);
  private sanitizer = inject(DomSanitizer);
  private icons: Record<string, string> = {};
  private fallbackIcon = 'hard-drive';

  constructor() {
    this.registerIcons();
  }

  private registerIcons(): void {
    const icons: Record<string, string> = {
      // ------------------- Titlebar Icons -------------------
      add: 'assets/icons/titlebar/add.svg',
      'check-box': 'assets/icons/titlebar/check-box.svg',
      close: 'assets/icons/titlebar/close.svg',
      'ellipsis-vertical': 'assets/icons/titlebar/ellipsis-vertical.svg',
      'menu-bar': 'assets/icons/titlebar/menu-bar.svg',
      remove: 'assets/icons/titlebar/remove.svg',
      search: 'assets/icons/titlebar/search.svg',

      // ------------------- App Icons -------------------
      bug: 'assets/icons/bug.svg',
      chart: 'assets/icons/chart.svg',
      cloud: 'assets/icons/cloud.svg',
      'cloud-arrow-up': 'assets/icons/cloud-arrow-up.svg',
      copy: 'assets/icons/copy.svg',
      download: 'assets/icons/download.svg',
      eject: 'assets/icons/eject.svg',
      error: 'assets/icons/circle-exclamation.svg',
      export: 'assets/icons/export.svg',
      eye: 'assets/icons/eye.svg',
      'eye-slash': 'assets/icons/eye-slash.svg',
      file: 'assets/icons/file.svg',
      filter: 'assets/icons/filter.svg',
      flask: 'assets/icons/flask.svg',
      folder: 'assets/icons/folder.svg',
      'hard-drive': 'assets/icons/hard-drive.svg',
      home: 'assets/icons/home.svg',
      info: 'assets/icons/info.svg',
      jobs: 'assets/icons/jobs.svg',
      lock: 'assets/icons/lock.svg',
      key: 'assets/icons/key.svg',
      mount: 'assets/icons/mount.svg',
      pause: 'assets/icons/pause.svg',
      pen: 'assets/icons/pen.svg',
      play: 'assets/icons/play.svg',
      'puzzle-piece': 'assets/icons/puzzle-piece.svg',
      question: 'assets/icons/question.svg',
      refresh: 'assets/icons/rotate.svg',
      remotes: 'assets/icons/remotes.svg',
      rclone: 'assets/rclone.svg',
      'rclone-symbolic': 'assets/rclone-symbolic.svg',
      'file-operations': 'assets/icons/file-operations.svg',
      stop: 'assets/icons/stop.svg',
      sync: 'assets/icons/folder-sync.svg',
      move: 'assets/icons/move.svg',
      terminal: 'assets/icons/terminal.svg',
      trash: 'assets/icons/trash.svg',
      vfs: 'assets/icons/vfs.svg',
      warning: 'assets/icons/warning.svg',
      wrench: 'assets/icons/wrench.svg',

      // ------------------- Remote Icons -------------------
      drive: 'assets/icons/remotes/drive.svg',
      dropbox: 'assets/icons/remotes/dropbox.svg',
      ftp: 'assets/icons/remotes/ftp.svg',
      memory: 'assets/icons/remotes/memory.svg',
      onedrive: 'assets/icons/remotes/onedrive.svg',
      s3: 'assets/icons/remotes/s3.svg',

      // ------------------- Theme Icons -------------------
      'circle-check': 'assets/icons/circle-check.svg',
      'circle-exclamation': 'assets/icons/circle-exclamation.svg',
      'circle-info': 'assets/icons/circle-info.svg',
      'circle-up': 'assets/icons/circle-up.svg',
      'circle-xmark': 'assets/icons/circle-xmark.svg',

      // ------------------- Navigation Icons -------------------
      'arrow-down': 'assets/icons/circle-chevron-down.svg',
      'arrow-rotate-left': 'assets/icons/arrow-rotate-left.svg',
      'arrow-up': 'assets/icons/circle-chevron-up.svg',
      bolt: 'assets/icons/bolt.svg',
      'caret-down': 'assets/icons/caret-down.svg',
      'caret-up': 'assets/icons/caret-up.svg',
      'chevron-left': 'assets/icons/chevron-left.svg',
      'chevron-right': 'assets/icons/chevron-right.svg',
      gear: 'assets/icons/gear.svg',
      'left-arrow': 'assets/icons/circle-arrow-left.svg',
      'no-internet': 'assets/icons/no-internet.svg',
      'open-link': 'assets/icons/arrow-up-right-from-square.svg',
      'right-arrow': 'assets/icons/circle-arrow-right.svg',
      'right-left': 'assets/icons/right-left.svg',
      star: 'assets/icons/star.svg',
    };

    this.icons = icons;

    for (const [name, path] of Object.entries(icons)) {
      this.iconRegistry.addSvgIcon(name, this.sanitizer.bypassSecurityTrustResourceUrl(path));
    }
  }
  getIconName(name: string | undefined | null): string {
    if (name && this.icons[name]) {
      return name;
    }
    return this.fallbackIcon;
  }
}
