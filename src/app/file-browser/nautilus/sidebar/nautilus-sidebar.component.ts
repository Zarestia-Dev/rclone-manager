import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatDividerModule } from '@angular/material/divider';
import { CdkMenuModule } from '@angular/cdk/menu';

import { IconService, PathSelectionService, RemoteFacadeService } from '@app/services';
import { ExplorerRoot, FileBrowserItem } from '@app/types';
import { OperationsPanelComponent } from '../../operations-panel/operations-panel.component';

@Component({
  selector: 'app-nautilus-sidebar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    TranslateModule,
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
  readonly iconService = inject(IconService);
  private readonly pathSelectionService = inject(PathSelectionService);
  private readonly remoteFacadeService = inject(RemoteFacadeService);

  // Inputs
  readonly isMobile = input.required<boolean>();
  readonly nautilusRemote = input.required<ExplorerRoot | null>();
  readonly starredMode = input.required<boolean>();
  readonly localDrives = input.required<ExplorerRoot[]>();
  readonly cloudRemotes = input.required<ExplorerRoot[]>();
  readonly bookmarks = input.required<FileBrowserItem[]>();
  readonly title = input.required<string>();
  readonly isDragging = input.required<boolean>();

  readonly currentPath = input('');
  readonly isPickerMode = input(false);
  readonly hoveredSidebarItem = input<string | null>(null);
  readonly isSearchMode = input(false);

  // Outputs
  readonly remoteSelected = output<ExplorerRoot>();
  readonly bookmarkOpened = output<FileBrowserItem>();
  readonly remoteOpenedInNewTab = output<ExplorerRoot>();
  readonly remoteOpenedInNewWindow = output<ExplorerRoot>();
  readonly bookmarkOpenedInNewTab = output<FileBrowserItem>();
  readonly bookmarkOpenedInNewWindow = output<FileBrowserItem>();
  readonly starredSelected = output<void>();
  readonly toggleSearch = output<void>();
  readonly requestShortcuts = output<void>();
  readonly sidenavAction = output<'close' | 'toggle'>();

  readonly requestAbout = output<ExplorerRoot>();
  readonly requestCleanup = output<ExplorerRoot>();
  readonly requestBookmarkRemoval = output<FileBrowserItem>();
  readonly requestProperties = output<FileBrowserItem>();

  readonly droppedToStarred = output<DragEvent>();
  readonly droppedToLocal = output<DragEvent>();
  readonly droppedToBookmark = output<{ event: DragEvent; target: FileBrowserItem }>();
  readonly droppedToRemote = output<{ event: DragEvent; target: ExplorerRoot }>();

  // Computed
  private readonly _activeKey = computed<string | null>(() => {
    if (this.starredMode() || !this.nautilusRemote()) return null;
    return `${this.nautilusRemote()!.name}::${this.currentPath()}`;
  });

  readonly anyBookmarkSelected = computed(() => {
    const active = this._activeKey();
    return active !== null && this.bookmarks().some(bm => this._bookmarkKey(bm) === active);
  });

  // Handlers
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
    return remote ? this.remoteFacadeService.featuresSignal(remote.name)().hasCleanUp : false;
  }

  private _bookmarkKey(bm: FileBrowserItem): string {
    const remote = this.pathSelectionService.normalizeRemoteName(
      bm.meta.remote ?? '',
      bm.meta.isLocal
    );
    return `${remote}::${bm.entry.Path}`;
  }

  private _closeSidenavOnMobile(): void {
    if (this.isMobile()) this.sidenavAction.emit('close');
  }
}
