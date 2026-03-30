import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatDividerModule } from '@angular/material/divider';

import { CdkMenuModule } from '@angular/cdk/menu';

import { IconService, PathSelectionService, RemoteFacadeService } from '@app/services';
import { ExplorerRoot, FileBrowserItem } from '@app/types';
import { OperationsPanelComponent } from '../../operations-panel/operations-panel.component';
import { NgTemplateOutlet } from '@angular/common';

@Component({
  selector: 'app-nautilus-sidebar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    TranslateModule,
    MatListModule,
    MatIconModule,
    MatToolbarModule,
    MatDividerModule,
    CdkMenuModule,
    OperationsPanelComponent,
  ],
  templateUrl: './nautilus-sidebar.component.html',
  styleUrl: './nautilus-sidebar.component.scss',
})
export class NautilusSidebarComponent {
  public readonly iconService = inject(IconService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly remoteFacadeService = inject(RemoteFacadeService);

  // --- Inputs ---
  public readonly isMobile = input.required<boolean>();
  public readonly nautilusRemote = input.required<ExplorerRoot | null>();
  public readonly starredMode = input.required<boolean>();
  public readonly localDrives = input.required<ExplorerRoot[]>();
  public readonly cloudRemotes = input.required<ExplorerRoot[]>();
  public readonly bookmarks = input.required<FileBrowserItem[]>();
  public readonly title = input.required<string>();
  public readonly isDragging = input.required<boolean>();

  public readonly currentPath = input<string>('');
  public readonly isPickerMode = input(false);
  public readonly hoveredSidebarItem = input<string | null>(null);
  public readonly isSearchMode = input(false);

  // --- Outputs ---
  public readonly remoteSelected = output<ExplorerRoot>();
  public readonly bookmarkOpened = output<FileBrowserItem>();
  public readonly remoteOpenedInNewTab = output<ExplorerRoot>();
  public readonly remoteOpenedInNewWindow = output<ExplorerRoot>();
  public readonly bookmarkOpenedInNewTab = output<FileBrowserItem>();
  public readonly bookmarkOpenedInNewWindow = output<FileBrowserItem>();
  public readonly starredSelected = output<void>();
  public readonly toggleSearch = output<void>();
  public readonly requestShortcuts = output<void>();
  public readonly sidenavAction = output<'close' | 'toggle'>();

  // Modal requests
  public readonly requestAbout = output<ExplorerRoot>();
  public readonly requestCleanup = output<ExplorerRoot>();
  public readonly requestBookmarkRemoval = output<FileBrowserItem>();
  public readonly requestProperties = output<FileBrowserItem>();

  // Drag & Drop events
  public readonly droppedToStarred = output<DragEvent>();
  public readonly droppedToLocal = output<DragEvent>();
  public readonly droppedToBookmark = output<{ event: DragEvent; target: FileBrowserItem }>();
  public readonly droppedToRemote = output<{ event: DragEvent; target: ExplorerRoot }>();

  /**
   * The active navigation key derived from the current remote + path.
   * Recomputes only when those signals change, not on every CD cycle.
   */
  private readonly _activeKey = computed<string | null>(() => {
    if (this.starredMode() || !this.nautilusRemote()) return null;
    return `${this.nautilusRemote()!.name}::${this.currentPath()}`;
  });

  /**
   * True when any bookmark exactly matches the current browsing location.
   * Drives the "don't highlight a remote when a bookmark is active" logic.
   */
  public readonly anyBookmarkSelected = computed(() => {
    const active = this._activeKey();
    if (!active) return false;
    return this.bookmarks().some(bm => this._bookmarkKey(bm) === active);
  });

  // --- Methods ---

  onToggleSearch(): void {
    this.toggleSearch.emit();
  }

  onSelectRemote(remote: ExplorerRoot): void {
    this.remoteSelected.emit(remote);
    this._closeSidenavOnMobile();
  }

  onOpenBookmark(bm: FileBrowserItem): void {
    this.bookmarkOpened.emit(bm);
    this._closeSidenavOnMobile();
  }

  onOpenRemoteInNewTab(remote: ExplorerRoot): void {
    this.remoteOpenedInNewTab.emit(remote);
    this._closeSidenavOnMobile();
  }

  onOpenRemoteInNewWindow(remote: ExplorerRoot): void {
    this.remoteOpenedInNewWindow.emit(remote);
    this._closeSidenavOnMobile();
  }

  onOpenBookmarkInNewTab(bm: FileBrowserItem): void {
    this.bookmarkOpenedInNewTab.emit(bm);
    this._closeSidenavOnMobile();
  }

  onOpenBookmarkInNewWindow(bm: FileBrowserItem): void {
    this.bookmarkOpenedInNewWindow.emit(bm);
    this._closeSidenavOnMobile();
  }

  isBookmarkSelected(bm: FileBrowserItem): boolean {
    const active = this._activeKey();
    return active !== null && this._bookmarkKey(bm) === active;
  }

  supportsCleanup(remote: ExplorerRoot | null): boolean {
    if (!remote) return false;
    return this.remoteFacadeService.featuresSignal(remote.name)().hasCleanUp;
  }

  private _bookmarkKey(bm: FileBrowserItem): string {
    const remote = this.pathSelectionService.normalizeRemoteName(
      bm.meta.remote ?? '',
      bm.meta.isLocal
    );
    return `${remote}::${bm.entry.Path}`;
  }

  private _closeSidenavOnMobile(): void {
    if (this.isMobile()) {
      this.sidenavAction.emit('close');
    }
  }
}
