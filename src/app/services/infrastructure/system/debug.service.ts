import { Injectable, inject, DestroyRef, DOCUMENT, isDevMode } from '@angular/core';
import { FileSystemService } from '../../operations/file-system.service';
import { TauriBaseService } from '../platform/tauri-base.service';

/**
 * Debug information returned from backend
 */
export interface DebugInfo {
  logsDir: string;
  configDir: string;
  cacheDir: string;
  mode: string;
  appVersion: string;
  platform: string;
  arch: string;
}

/**
 * Service for debugging and troubleshooting tools
 */
@Injectable({
  providedIn: 'root',
})
export class DebugService extends TauriBaseService {
  private readonly fileSystemService = inject(FileSystemService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  private contextMenu: HTMLElement | null = null;

  constructor() {
    super();
    this.setupContextMenu();
  }

  /**
   * Restart the application
   */
  async restartApp(): Promise<void> {
    await this.invokeCommand<void>('relaunch_app');
  }

  /**
   * Get debug information (paths, versions, build info)
   */
  async getDebugInfo(): Promise<DebugInfo> {
    return this.invokeCommand<DebugInfo>('get_debug_info');
  }

  /**
   * Open a folder in the system file manager
   * @param folderType - Type of folder: 'logs', 'config', or 'cache'
   */
  async openFolder(folderType: 'logs' | 'config' | 'cache'): Promise<void> {
    try {
      // First get the debug info to get the actual paths
      const debugInfo = await this.getDebugInfo();
      let path: string;

      switch (folderType) {
        case 'logs':
          path = debugInfo.logsDir;
          break;
        case 'config':
          path = debugInfo.configDir;
          break;
        case 'cache':
          path = debugInfo.cacheDir;
          break;
      }

      // Use the unified file manager logic
      await this.fileSystemService.openInFiles(path);
    } catch (error) {
      console.error('Failed to open folder:', error);
      this.notificationService.showError(this.translate.instant('home.errors.generic'));
      throw error;
    }
  }

  /**
   * Open developer tools
   * - Desktop (Tauri): Opens WebView DevTools via backend command
   * - Headless (Browser): Shows instruction to use F12 (can't programmatically open browser DevTools)
   */
  async openDevTools(): Promise<void> {
    if (this.apiClient.isHeadless()) {
      this.notificationService.showSuccess(
        this.translate.instant('developerTools.openDevToolsHint')
      );
      return;
    }

    try {
      await this.apiClient.invoke<string>('open_devtools');
    } catch (error) {
      console.error('Failed to open devtools:', error);
      this.notificationService.showError(
        this.translate.instant('developerTools.openDevToolsError')
      );
      throw error;
    }
  }

  private setupContextMenu(): void {
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault();

      const tag = (e.target as HTMLElement).tagName;
      if (['INPUT', 'TEXTAREA'].includes(tag)) return;

      this.createContextMenu(e.clientX, e.clientY);
    };
    const onClose = (): void => this.closeMenu();
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.closeMenu();
    };

    this.document.addEventListener('contextmenu', onContextMenu);
    this.document.addEventListener('click', onClose);
    this.document.addEventListener('keydown', onKeydown);

    this.destroyRef.onDestroy(() => {
      this.document.removeEventListener('contextmenu', onContextMenu);
      this.document.removeEventListener('click', onClose);
      this.document.removeEventListener('keydown', onKeydown);
      this.closeMenu();
    });
  }

  private createContextMenu(x: number, y: number): void {
    this.closeMenu();

    this.contextMenu = this.document.createElement('div');
    this.contextMenu.className = 'material-context-menu';
    this.contextMenu.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      z-index: 99999;
    `;

    const menuItems = [
      {
        label: this.translate.instant('developerTools.refreshUi'),
        action: (): void => this.refreshUI(),
      },
      {
        label: this.translate.instant('developerTools.clearCache'),
        action: (): void => this.clearCache(),
      },
      ...(isDevMode()
        ? [
            {
              label: this.translate.instant('developerTools.openDevTools'),
              action: (): void => void this.openDevTools(),
            },
          ]
        : []),
    ];

    menuItems.forEach(item => {
      const menuItem = this.document.createElement('button');
      menuItem.className = 'menu-item';
      menuItem.innerHTML = `<span>${item.label}</span>`;
      menuItem.onclick = (): void => {
        item.action();
        this.closeMenu();
      };
      this.contextMenu?.appendChild(menuItem);
    });

    this.document.body.appendChild(this.contextMenu);

    // Adjust position if menu goes off-screen
    if (this.contextMenu) {
      const rect = this.contextMenu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        this.contextMenu.style.left = `${x - rect.width}px`;
      }
      if (rect.bottom > window.innerHeight) {
        this.contextMenu.style.top = `${y - rect.height}px`;
      }
    }
  }

  private closeMenu(): void {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  private refreshUI(): void {
    sessionStorage.clear();
    window.location.reload();
  }

  private clearCache(): void {
    // 1. Clear Local/Session Storage
    sessionStorage.clear();
    localStorage.clear();

    // 2. Clear Cookies — trim whitespace to ensure deletion matches the stored name
    const cookies = this.document.cookie.split(';');
    for (const cookie of cookies) {
      const eqPos = cookie.indexOf('=');
      const name = (eqPos > -1 ? cookie.substring(0, eqPos) : cookie).trim();
      this.document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    }

    // 3. Clear Cache API (Service Workers)
    if ('caches' in window) {
      void caches.keys().then(names => names.forEach(n => void caches.delete(n)));
    }

    this.notificationService.showSuccess(this.translate.instant('developerTools.cleared'));
  }
}
