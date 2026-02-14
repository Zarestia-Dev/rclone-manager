import { Injectable, inject, DOCUMENT, isDevMode } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ApiClientService } from '../core/api-client.service';
import { NotificationService } from '../ui/notification.service';
import { NautilusService } from '../ui/nautilus.service';

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
export class DebugService {
  private readonly apiClient = inject(ApiClientService);
  private readonly notificationService = inject(NotificationService);
  private readonly nautilusService = inject(NautilusService);
  private readonly document = inject(DOCUMENT);
  private readonly translateService = inject(TranslateService);

  private contextMenu: HTMLElement | null = null;

  // constructor() {
  //   this.setupContextMenu();
  // }

  /**
   * Get debug information (paths, versions, build info)
   */
  async getDebugInfo(): Promise<DebugInfo> {
    return this.apiClient.invoke<DebugInfo>('get_debug_info');
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

      // Use the existing open_in_files command
      if (this.apiClient.isHeadless()) {
        // In headless mode, use the in-app Nautilus file browser
        this.nautilusService.openPath(path);
      } else {
        // In desktop mode, use the system file explorer
        await this.apiClient.invoke<string>('open_in_files', { path });
      }
    } catch (error) {
      console.error('Failed to open folder:', error);
      this.notificationService.openSnackBar(`Failed to open ${folderType} folder`, 'Close');
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
      // Browser mode - can't programmatically open DevTools, show instruction
      this.notificationService.openSnackBar(
        'Press F12 or right-click → Inspect to open browser DevTools',
        'OK',
        5000
      );
      return;
    }

    // Tauri desktop mode - call backend to open WebView DevTools
    try {
      await this.apiClient.invoke<string>('open_devtools');
    } catch (error) {
      console.error('Failed to open DevTools:', error);
      this.notificationService.openSnackBar('Failed to open DevTools', 'Close');
      throw error;
    }
  }

  // private setupContextMenu(): void {
  //   // Handle right-click
  //   this.document.addEventListener('contextmenu', (event: MouseEvent) => {
  //     event.preventDefault();
  //     this.createContextMenu(event.clientX, event.clientY);
  //   });

  //   // Close menu on click outside
  //   this.document.addEventListener('click', () => this.closeMenu());

  //   // Close menu on escape
  //   this.document.addEventListener('keydown', (event: KeyboardEvent) => {
  //     if (event.key === 'Escape') {
  //       this.closeMenu();
  //     }
  //   });
  // }

  private createContextMenu(x: number, y: number): void {
    this.closeMenu();

    this.contextMenu = this.document.createElement('div');
    this.contextMenu.className = 'material-context-menu';
    if (this.contextMenu) {
      this.contextMenu.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      z-index: 99999;
    `;
    }

    const menuItems = [
      {
        label: this.translateService.instant('developerTools.refreshUi'),
        action: (): void => this.refreshUI(),
      },
      {
        label: this.translateService.instant('developerTools.clearCache'),
        action: (): void => this.clearCache(),
      },
      ...(isDevMode()
        ? [
            {
              label: this.translateService.instant('developerTools.openDevTools'),
              action: (): void => {
                void this.openDevTools();
              },
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
    const feedback = this.document.createElement('div');
    feedback.textContent = this.translateService.instant('developerTools.clearing');
    feedback.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: var(--primary-color);
      color: white;
      padding: 16px 32px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      z-index: 99999;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      animation: fadeIn 0.2s ease-out;
      pointer-events: none;
    `;
    this.document.body.appendChild(feedback);

    // 1. Clear Local/Session Storage
    sessionStorage.clear();
    localStorage.clear();

    // 2. Clear Cookies
    const cookies = this.document.cookie.split(';');
    for (const cookie of cookies) {
      const eqPos = cookie.indexOf('=');
      const name = eqPos > -1 ? cookie.substring(0, eqPos) : cookie;
      this.document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    }

    // 3. Clear Cache API (Service Workers)
    if ('caches' in window) {
      caches.keys().then(names => {
        for (const name of names) {
          caches.delete(name);
        }
      });
    }

    // Update feedback
    setTimeout(() => {
      feedback.textContent = this.translateService.instant('developerTools.cleared');
      setTimeout(() => {
        feedback.style.animation = 'fadeOut 0.2s ease-out forwards';
        setTimeout(() => feedback.remove(), 300);
      }, 1000);
    }, 500);
  }
}
