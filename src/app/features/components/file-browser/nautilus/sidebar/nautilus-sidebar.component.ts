import { Component, inject, input, output, signal, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { DragDropModule, CdkDragDrop, CdkDrag } from '@angular/cdk/drag-drop';
import { CdkMenuModule } from '@angular/cdk/menu';

import { IconService, PathSelectionService, RemoteFacadeService } from '@app/services';
import { ExplorerRoot, FileBrowserItem } from '@app/types';
import { OperationsPanelComponent } from '../../operations-panel/operations-panel.component';

@Component({
  selector: 'app-nautilus-sidebar',
  standalone: true,
  imports: [
    CommonModule,
    TranslateModule,
    MatListModule,
    MatIconModule,
    MatToolbarModule,
    MatButtonModule,
    MatDividerModule,
    DragDropModule,
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
  public readonly currentPath = input<string>('');

  // Drag Drop Predicates
  public readonly canDropOnStarred = input.required<(item: CdkDrag<FileBrowserItem>) => boolean>();
  public readonly canDropOnBookmarks =
    input.required<(item: CdkDrag<FileBrowserItem>) => boolean>();
  public readonly canDropOnBookmark = input.required<(item: CdkDrag<FileBrowserItem>) => boolean>();
  public readonly canAcceptFile = input.required<(item: CdkDrag<FileBrowserItem>) => boolean>();

  // --- Outputs ---
  public readonly remoteSelected = output<ExplorerRoot>();
  public readonly bookmarkOpened = output<FileBrowserItem>();
  public readonly starredSelected = output<void>();
  public readonly toggleSearch = output<void>();
  public readonly requestShortcuts = output<void>();
  public readonly sidenavAction = output<'close' | 'toggle'>();

  // Modal Requests
  public readonly requestAbout = output<ExplorerRoot>();
  public readonly requestCleanup = output<ExplorerRoot>();
  public readonly requestBookmarkRemoval = output<FileBrowserItem>();
  public readonly requestProperties = output<FileBrowserItem>();

  // Drag Drop Events
  public readonly droppedToStarred = output<CdkDragDrop<void, FileBrowserItem[]>>();
  public readonly droppedToLocal = output<CdkDragDrop<FileBrowserItem[], FileBrowserItem[]>>();
  public readonly droppedToBookmark = output<{
    event: CdkDragDrop<FileBrowserItem, FileBrowserItem[]>;
    target: FileBrowserItem;
  }>();
  public readonly droppedToRemote = output<{
    event: CdkDragDrop<ExplorerRoot, FileBrowserItem[]>;
    target: ExplorerRoot;
  }>();

  // --- UI State ---
  public readonly isSearchMode = signal(false);
  public sideContextRemote = signal<ExplorerRoot | null>(null);
  public bookmarkContextItem: FileBrowserItem | null = null;

  // Current path for bookmark selection highlighting

  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;

  toggleSearchMode(): void {
    this.isSearchMode.set(!this.isSearchMode());
    this.toggleSearch.emit();
    if (this.isSearchMode()) {
      setTimeout(() => {
        this.searchInput?.nativeElement?.focus();
        this.searchInput?.nativeElement?.select();
      }, 10);
    }
  }

  onSelectRemote(remote: ExplorerRoot): void {
    this.remoteSelected.emit(remote);
    if (this.isMobile()) {
      this.sidenavAction.emit('close');
    }
  }

  onOpenBookmark(bm: FileBrowserItem): void {
    this.bookmarkOpened.emit(bm);
    if (this.isMobile()) {
      this.sidenavAction.emit('close');
    }
  }

  trackByRemote(index: number, remote: ExplorerRoot): string {
    return remote.name;
  }

  trackByBookmark(index: number, item: FileBrowserItem): string {
    return `${item.meta.remote}:${item.entry.Path}`;
  }

  /** Returns true when the user is currently browsing this bookmark's exact path. */
  isBookmarkSelected(bm: FileBrowserItem): boolean {
    if (this.starredMode() || !this.nautilusRemote()) return false;
    const bmRemote = this.pathSelectionService.normalizeRemoteName(
      bm.meta.remote ?? '',
      bm.meta.isLocal
    );
    const remote = this.nautilusRemote();
    return remote?.name === bmRemote && this.currentPath() === bm.entry.Path;
  }

  /** Returns true when any bookmark matches the current location (so remotes should not show selected). */
  isAnyBookmarkSelected(): boolean {
    return this.bookmarks().some(bm => this.isBookmarkSelected(bm));
  }

  supportsCleanup(remote: ExplorerRoot | null): boolean {
    if (!remote) return false;
    return this.remoteFacadeService.featuresSignal(remote.name)().hasCleanUp;
  }
}
