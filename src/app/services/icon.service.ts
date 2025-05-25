import { Injectable } from "@angular/core";
import { DomSanitizer } from "@angular/platform-browser";
import { MatIconRegistry } from "@angular/material/icon";

@Injectable({
  providedIn: "root",
})
export class IconService {
  private icons: Record<string, string> = {};
  private fallbackIcon = "hard-drive";

  constructor(
    private iconRegistry: MatIconRegistry,
    private sanitizer: DomSanitizer
  ) {
    this.registerIcons();
  }

  private registerIcons(): void {
    const icons: Record<string, string> = {
      // Titlebar icons
      add: "assets/icons/titlebar/add.svg",
      "menu-bar": "assets/icons/titlebar/menu-bar.svg",
      remove: "assets/icons/titlebar/remove.svg",
      check_box: "assets/icons/titlebar/check_box.svg",
      close: "assets/icons/titlebar/close.svg",
      "ellipsis-vertical": "assets/icons/titlebar/ellipsis-vertical.svg",

      // App icons
      mount: "assets/icons/mount.svg",
      vfs: "assets/icons/vfs.svg",
      sync: "assets/icons/folder-sync.svg",
      copy: "assets/icons/copy.svg",
      jobs: "assets/icons/jobs.svg",
      filter: "assets/icons/filter.svg",
      "hard-drive": "assets/icons/hard-drive.svg",
      folder: "assets/icons/folder.svg",
      "circle-exclamation": "assets/icons/circle-exclamation.svg",
      "circle-xmark": "assets/icons/circle-xmark.svg",
      wrench: "assets/icons/wrench.svg",
      pen: "assets/icons/pen.svg",
      download: "assets/icons/download.svg",
      remotes: "assets/icons/remotes.svg",
      search: "assets/icons/titlebar/search.svg",
      "puzzle-piece": "assets/icons/puzzle-piece.svg",
      flask: "assets/icons/flask.svg",
      question: "assets/icons/question.svg",
      terminal: "assets/icons/terminal.svg",
      trash: "assets/icons/trash.svg",
      refresh: "assets/icons/rotate.svg",
      "no-internet": "assets/icons/no-internet.svg",
      error: "assets/icons/triangle-exclamation.svg",
      eye: "assets/icons/eye.svg",
      "eye-slash": "assets/icons/eye-slash.svg",
      file: "assets/icons/file.svg",

      play: "assets/icons/play.svg",
      pause: "assets/icons/pause.svg",
      "cloud-arrow-up": "assets/icons/cloud-arrow-up.svg",

      // Remote icons
      drive: "assets/icons/remotes/drive.svg",
      dropbox: "assets/icons/remotes/dropbox.svg",
      ftp: "assets/icons/remotes/ftp.svg",
      onedrive: "assets/icons/remotes/onedrive.svg",
      s3: "assets/icons/remotes/s3.svg",
      memory: "assets/icons/remotes/memory.svg",

      // Theme icons
      "circle-check": "assets/icons/circle-check.svg",

      // App icons
      "rclone-symbolic": "assets/rclone-symbolic.svg",
      rclone: "assets/rclone.svg",
      "rclone-2": "assets/rclone-2.svg",

      // Navigation icons
      "left-arrow": "assets/icons/circle-arrow-left.svg",
      "right-arrow": "assets/icons/circle-arrow-right.svg",
      "chevron-right": "assets/icons/chevron-right.svg",
      "chevron-left": "assets/icons/chevron-left.svg",
      "open-link": "assets/icons/arrow-up-right-from-square.svg",
      "arrow-up": "assets/icons/circle-chevron-up.svg",
      "arrow-down": "assets/icons/circle-chevron-down.svg",
      "caret-up": "assets/icons/caret-up.svg",
      "caret-down": "assets/icons/caret-down.svg",
    };

    this.icons = icons;

    for (const [name, path] of Object.entries(icons)) {
      this.iconRegistry.addSvgIcon(
        name,
        this.sanitizer.bypassSecurityTrustResourceUrl(path)
      );
    }
  }
  getIconName(name: string | undefined | null): string {
    if (name && this.icons[name]) {
      return name;
    }
    return this.fallbackIcon;
  }
}
