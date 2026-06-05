import { Injectable, inject, DestroyRef, DOCUMENT, isDevMode } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { FileSystemService } from '../../operations/file-system.service';
import { TauriBaseService } from '../platform/tauri-base.service';
import { isHeadlessMode } from '@app/services';

export interface DebugInfo {
  logsDir: string;
  configDir: string;
  cacheDir: string;
  mode: string;
  appVersion: string;
  platform: string;
  arch: string;
}

interface MenuAction {
  label: string;
  action: () => void | Promise<void>;
  shortcut?: string;
}
type MenuEntry = MenuAction | 'divider';

const FOLDER_DIR_KEYS = {
  logs: 'logsDir',
  config: 'configDir',
  cache: 'cacheDir',
} as const satisfies Record<string, keyof DebugInfo>;

@Injectable({ providedIn: 'root' })
export class DebugService extends TauriBaseService {
  private readonly fileSystemService = inject(FileSystemService);
  private readonly doc = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly clipboard = inject(Clipboard);

  private contextMenu: HTMLElement | null = null;
  private pasteBtn: HTMLButtonElement | null = null;
  private activeInput: HTMLInputElement | HTMLTextAreaElement | null = null;

  constructor() {
    super();
    this.setupContextMenu();
    this.setupPasteHelper();
  }

  restartApp(): Promise<void> {
    return this.invokeCommand<void>('relaunch_app');
  }

  getDebugInfo(): Promise<DebugInfo> {
    return this.invokeCommand<DebugInfo>('get_debug_info');
  }

  async openFolder(folderType: 'logs' | 'config' | 'cache'): Promise<void> {
    try {
      const info = await this.getDebugInfo();
      await this.fileSystemService.openInFiles(info[FOLDER_DIR_KEYS[folderType]]);
    } catch (err) {
      console.error('Failed to open folder:', err);
      this.notificationService.showError(this.t('home.errors.generic'));
      throw err;
    }
  }

  async openDevTools(): Promise<void> {
    if (isHeadlessMode()) {
      this.notificationService.showSuccess(this.t('developerTools.openDevToolsHint'));
      return;
    }
    try {
      await this.invokeCommand<string>('open_devtools');
    } catch (err) {
      console.error('Failed to open devtools:', err);
      this.notificationService.showError(this.t('developerTools.openDevToolsError'));
      throw err;
    }
  }

  private setupContextMenu(): void {
    const onContextMenu = (e: MouseEvent): void => this.handleContextMenu(e);
    this.doc.addEventListener('contextmenu', onContextMenu);
    this.destroyRef.onDestroy(() => {
      this.doc.removeEventListener('contextmenu', onContextMenu);
      this.closeMenu();
    });
  }

  private setupPasteHelper(): void {
    const onFocusIn = (e: FocusEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      if (!isInput) return;

      const inputEl = target as HTMLInputElement | HTMLTextAreaElement;
      const type = inputEl.getAttribute('type') || 'text';
      const isSupportedType =
        ['text', 'search', 'url', 'email', 'tel', 'number', 'password'].includes(
          type.toLowerCase()
        ) || target.tagName === 'TEXTAREA';

      if (!isSupportedType || inputEl.readOnly || inputEl.disabled) return;

      this.showPasteButton(inputEl);
    };

    const onFocusOut = (): void => {
      setTimeout(() => {
        const active = this.doc.activeElement;
        if (active !== this.pasteBtn && active !== this.activeInput) {
          this.hidePasteButton();
        }
      }, 150);
    };

    const onScroll = (): void => {
      if (this.activeInput) {
        this.updatePasteButtonPosition();
      }
    };

    const onInput = (): void => {
      this.hidePasteButton();
    };

    const onResize = (): void => {
      if (this.activeInput) {
        this.updatePasteButtonPosition();
      }
    };

    this.doc.addEventListener('focusin', onFocusIn);
    this.doc.addEventListener('focusout', onFocusOut);
    this.doc.addEventListener('scroll', onScroll, { capture: true });
    this.doc.addEventListener('input', onInput);
    window.addEventListener('resize', onResize);

    this.destroyRef.onDestroy(() => {
      this.doc.removeEventListener('focusin', onFocusIn);
      this.doc.removeEventListener('focusout', onFocusOut);
      this.doc.removeEventListener('scroll', onScroll, { capture: true });
      this.doc.removeEventListener('input', onInput);
      window.removeEventListener('resize', onResize);
      if (this.pasteBtn) {
        try {
          (this.pasteBtn as any).hidePopover();
        } catch {
          /* ignore */
        }
        this.pasteBtn.remove();
        this.pasteBtn = null;
      }
    });
  }

  private createPasteButton(): void {
    this.pasteBtn = this.doc.createElement('button');
    this.pasteBtn.setAttribute('tabindex', '-1');
    this.pasteBtn.setAttribute('popover', 'manual');
    this.pasteBtn.className = 'floating-paste-button';

    this.pasteBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512" style="width: 12px; height: 12px; fill: currentColor;">
        <path d="M192 0c-41.8 0-77.4 26.7-90.5 64H64C28.7 64 0 92.7 0 128V448c0 35.3 28.7 64 64 64H320c35.3 0 64-28.7 64-64V128c0-35.3-28.7-64-64-64H282.5C269.4 26.7 233.8 0 192 0zm0 64a32 32 0 1 1 0 64 32 32 0 1 1 0-64zM112 192H272c8.8 0 16 7.2 16 16s-7.2 16-16 16H112c-8.8 0-16-7.2-16-16s7.2-16 16-16zM96 304c0-8.8 7.2-16 16-16H272c8.8 0 16 7.2 16 16s-7.2 16-16 16H112c-8.8 0-16-7.2-16-16zm16 80H272c8.8 0 16 7.2 16 16s-7.2 16-16 16H112c-8.8 0-16-7.2-16-16s7.2-16 16-16z"/>
      </svg>
    `;

    this.pasteBtn.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
    });

    this.pasteBtn.addEventListener('click', async (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.activeInput) {
        await this.paste(this.activeInput, null);
      }
    });

    this.doc.body.appendChild(this.pasteBtn);
  }

  private showPasteButton(inputEl: HTMLInputElement | HTMLTextAreaElement): void {
    this.activeInput = inputEl;

    if (!this.pasteBtn) {
      this.createPasteButton();
    }

    if (this.pasteBtn) {
      this.pasteBtn.style.display = 'flex';
      try {
        (this.pasteBtn as any).showPopover();
      } catch {
        /* ignore */
      }
      this.updatePasteButtonPosition();
      requestAnimationFrame(() => this.pasteBtn?.classList.add('visible'));
    }
  }

  private hidePasteButton(): void {
    if (this.pasteBtn) {
      this.pasteBtn.classList.remove('visible');
      const btn = this.pasteBtn;
      setTimeout(() => {
        if (btn && !btn.classList.contains('visible')) {
          try {
            (btn as any).hidePopover();
          } catch {
            /* ignore */
          }
          btn.style.display = 'none';
        }
      }, 120);
    }
    this.activeInput = null;
  }

  private updatePasteButtonPosition(): void {
    if (!this.pasteBtn || !this.activeInput) return;

    const rect = this.activeInput.getBoundingClientRect();
    const viewWidth = window.innerWidth || this.doc.documentElement.clientWidth;
    const viewHeight = window.innerHeight || this.doc.documentElement.clientHeight;

    const isOutViewport =
      rect.bottom < 0 || rect.top > viewHeight || rect.right < 0 || rect.left > viewWidth;

    if (isOutViewport || rect.width < 80 || rect.height < 20) {
      this.hidePasteButton();
      return;
    }

    const buttonSize = 24;
    const computedStyle = window.getComputedStyle(this.activeInput);
    const paddingRight = parseFloat(computedStyle.paddingRight) || 0;

    const offset = Math.max(6, paddingRight);
    const x = rect.right - buttonSize - offset + 4;
    const y = rect.top + (rect.height - buttonSize) / 2;

    this.pasteBtn.style.left = `${x}px`;
    this.pasteBtn.style.top = `${y}px`;
  }

  private handleContextMenu(e: MouseEvent): void {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // Dismiss any open CDK overlays before showing ours
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    e.preventDefault();
    this.createContextMenu(e.clientX, e.clientY, this.buildMenuItems(target));
  }

  private buildMenuItems(target: HTMLElement): MenuEntry[] {
    const inputEl = target.closest('input, textarea') as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    const editableEl = !inputEl
      ? (target.closest('[contenteditable="true"]') as HTMLElement | null)
      : null;

    const isPassword = inputEl?.type === 'password';
    const isReadOnly = !!(
      inputEl?.readOnly ||
      inputEl?.disabled ||
      editableEl?.getAttribute('contenteditable') === 'false'
    );
    const isDisabled = !!inputEl?.disabled;

    const selectedText =
      inputEl && !isPassword
        ? inputEl.value.substring(inputEl.selectionStart ?? 0, inputEl.selectionEnd ?? 0)
        : (window.getSelection()?.toString() ?? '');

    const isInput = !!(inputEl || editableEl);
    const items: MenuEntry[] = [];

    if (isInput) {
      if (selectedText) {
        if (!isPassword && !isReadOnly && !isDisabled) {
          items.push({
            label: this.t('nautilus.contextMenu.cut'),
            shortcut: 'Ctrl+X',
            action: () => this.cut(selectedText, inputEl, editableEl),
          });
        }
        if (!isPassword) {
          items.push({
            label: this.t('nautilus.contextMenu.copy'),
            shortcut: 'Ctrl+C',
            action: () => void this.clipboard.copy(selectedText),
          });
        }
      }
      if (!isReadOnly && !isDisabled) {
        items.push({
          label: this.t('nautilus.contextMenu.paste'),
          shortcut: 'Ctrl+V',
          action: () => this.paste(inputEl, editableEl),
        });
      }
      if (!isDisabled) {
        items.push({
          label: this.t('nautilus.contextMenu.selectAll'),
          shortcut: 'Ctrl+A',
          action: () => this.selectAll(inputEl, editableEl),
        });
      }
    } else if (selectedText && !isPassword) {
      items.push({
        label: this.t('nautilus.contextMenu.copy'),
        shortcut: 'Ctrl+C',
        action: () => void this.clipboard.copy(selectedText),
      });
    }

    const isStandalone = new URLSearchParams(window.location.search).get('standalone') === 'dialog';
    const hasBottomItems = (!isStandalone && !isInput) || isDevMode();

    if (items.length && hasBottomItems) items.push('divider');

    if (!isStandalone && !isInput) {
      items.push(
        {
          label: this.t('developerTools.refreshUi'),
          action: () => this.refreshUI(),
        },
        {
          label: this.t('developerTools.clearCache'),
          action: () => this.clearCache(),
        }
      );
    }

    if (isDevMode()) {
      items.push({
        label: this.t('developerTools.openDevTools'),
        action: () => void this.openDevTools(),
      });
    }

    return items;
  }

  private cut(
    text: string,
    inputEl: HTMLInputElement | HTMLTextAreaElement | null,
    editableEl: HTMLElement | null
  ): void {
    this.clipboard.copy(text);
    if (inputEl) {
      const start = inputEl.selectionStart ?? 0;
      const end = inputEl.selectionEnd ?? 0;
      inputEl.value = inputEl.value.substring(0, start) + inputEl.value.substring(end);
      inputEl.selectionStart = inputEl.selectionEnd = start;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (editableEl) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
      }
    }
  }

  private async paste(
    inputEl: HTMLInputElement | HTMLTextAreaElement | null,
    editableEl: HTMLElement | null
  ): Promise<void> {
    let text = '';
    try {
      text = await this.readClipboard();
    } catch (err) {
      console.error('Paste failed:', err);
    }
    if (!text) return;

    if (inputEl) {
      const start = inputEl.selectionStart ?? 0;
      const end = inputEl.selectionEnd ?? 0;
      inputEl.value = inputEl.value.substring(0, start) + text + inputEl.value.substring(end);
      inputEl.selectionStart = inputEl.selectionEnd = start + text.length;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (editableEl) {
      editableEl.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const textNode = this.doc.createTextNode(text);
        range.insertNode(textNode);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

  private selectAll(
    inputEl: HTMLInputElement | HTMLTextAreaElement | null,
    editableEl: HTMLElement | null
  ): void {
    if (inputEl) {
      inputEl.select();
      return;
    }
    if (editableEl) {
      const range = this.doc.createRange();
      range.selectNodeContents(editableEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }

  private async readClipboard(): Promise<string> {
    if (isHeadlessMode()) return navigator.clipboard.readText();
    const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
    return readText();
  }

  private createContextMenu(x: number, y: number, items: MenuEntry[]): void {
    this.closeMenu();

    this.contextMenu = this.doc.createElement('div');
    this.contextMenu.className = 'material-context-menu';
    this.contextMenu.setAttribute('popover', 'manual');
    this.contextMenu.style.cssText = `position:fixed;inset:auto;left:${x}px;top:${y}px;z-index:99999;margin:0;border:none`;

    for (const item of items) {
      if (item === 'divider') {
        const sep = this.doc.createElement('mat-divider');
        this.contextMenu.appendChild(sep);
        continue;
      }

      const btn = this.doc.createElement('button');
      btn.className = `menu-item${item.shortcut ? ' space-between' : ''}`;
      btn.innerHTML = `
        <span class="item-label">${item.label}</span>
        ${item.shortcut ? `<span class="shortcut">${item.shortcut}</span>` : ''}
      `;
      btn.onclick = async (): Promise<void> => {
        await item.action();
        this.closeMenu();
      };
      this.contextMenu.appendChild(btn);
    }

    this.doc.body.appendChild(this.contextMenu);
    try {
      (this.contextMenu as any).showPopover();
    } catch {
      /* popover not supported, menu visible via fixed positioning */
    }

    // Flip if off-screen
    const { right, bottom, width, height } = this.contextMenu.getBoundingClientRect();
    if (right > window.innerWidth) this.contextMenu.style.left = `${x - width}px`;
    if (bottom > window.innerHeight) this.contextMenu.style.top = `${y - height}px`;

    // Dynamic active-menu listeners
    this.doc.addEventListener('mousedown', this.onGlobalMousedown);
    this.doc.addEventListener('keydown', this.onGlobalKeydown);
  }

  private closeMenu(): void {
    if (!this.contextMenu) return;
    try {
      (this.contextMenu as any).hidePopover();
    } catch {
      /* ignore */
    }
    this.contextMenu.remove();
    this.contextMenu = null;

    this.doc.removeEventListener('mousedown', this.onGlobalMousedown);
    this.doc.removeEventListener('keydown', this.onGlobalKeydown);
  }

  private readonly onGlobalMousedown = (e: MouseEvent): void => {
    if (!this.contextMenu?.contains(e.target as Node)) {
      this.closeMenu();
    }
  };

  private readonly onGlobalKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.closeMenu();
    }
  };

  private refreshUI(): void {
    sessionStorage.clear();
    window.location.reload();
  }

  private async clearCache(): Promise<void> {
    sessionStorage.clear();
    // Preserve rcman.* keys (managed by LocalStorageService)
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && !key.startsWith('rcman.')) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));

    if (this.doc.cookie) {
      for (const cookie of this.doc.cookie.split(';')) {
        const name = cookie.split('=')[0].trim();
        this.doc.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      }
    }

    if ('caches' in window) {
      try {
        const names = await caches.keys();
        await Promise.all(names.map(name => caches.delete(name)));
      } catch (err) {
        console.error('Failed to clear caches:', err);
      }
    }

    this.notificationService.showSuccess(this.t('developerTools.cleared'));
  }

  private t(key: string): string {
    return this.translate.instant(key);
  }
}
