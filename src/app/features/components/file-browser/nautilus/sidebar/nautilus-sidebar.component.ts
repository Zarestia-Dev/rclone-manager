import {
  Component,
  EventEmitter,
  inject,
  Input,
  Output,
  signal,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { DragDropModule, CdkDragDrop } from '@angular/cdk/drag-drop';
import { CdkMenuModule } from '@angular/cdk/menu';

import { NautilusService, IconService } from '@app/services';
import { ExplorerRoot, FileBrowserItem, FilePickerConfig } from '@app/types';
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
  private readonly nautilusService = inject(NautilusService);

  // --- Inputs ---
  @Input({ required: true }) isMobile = false;
  @Input({ required: true }) nautilusRemote: ExplorerRoot | null = null;
  @Input({ required: true }) starredMode = false;
  @Input({ required: true }) localDrives: ExplorerRoot[] = [];
  @Input({ required: true }) cloudRemotes: ExplorerRoot[] = [];
  @Input({ required: true }) bookmarks: FileBrowserItem[] = [];
  @Input({ required: true }) title = '';

  // Data caches for operations
  @Input({ required: true }) cleanupSupportCache: Record<string, boolean> = {};

  // Drag Drop Predicates
  @Input() canDropOnStarred!: (item: any) => boolean;
  @Input() canDropOnBookmarks!: (item: any) => boolean;
  @Input() canDropOnBookmark!: (item: any) => boolean;
  @Input() canAcceptFile!: (item: any) => boolean;

  // --- Outputs ---
  @Output() remoteSelected = new EventEmitter<ExplorerRoot>();
  @Output() bookmarkOpened = new EventEmitter<FileBrowserItem>();
  @Output() starredSelected = new EventEmitter<void>();
  @Output() toggleSearch = new EventEmitter<void>();
  @Output() sidenavAction = new EventEmitter<'close' | 'toggle'>();

  // Modal Requests
  @Output() requestAbout = new EventEmitter<ExplorerRoot>();
  @Output() requestCleanup = new EventEmitter<ExplorerRoot>();
  @Output() requestBookmarkRemoval = new EventEmitter<FileBrowserItem>();
  @Output() requestProperties = new EventEmitter<FileBrowserItem>();

  // Drag Drop Events
  @Output() droppedToStarred = new EventEmitter<CdkDragDrop<any>>();
  @Output() droppedToLocal = new EventEmitter<CdkDragDrop<any>>();
  @Output() droppedToBookmark = new EventEmitter<{
    event: CdkDragDrop<any>;
    target: FileBrowserItem;
  }>();
  @Output() droppedToRemote = new EventEmitter<{ event: CdkDragDrop<any>; target: ExplorerRoot }>();

  // --- UI State ---
  public readonly isSearchMode = signal(false);
  public sideContextRemote = signal<ExplorerRoot | null>(null);
  public bookmarkContextItem: FileBrowserItem | null = null;

  // Current path for bookmark selection highlighting
  @Input() currentPath: string = '';

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
    if (this.isMobile) {
      this.sidenavAction.emit('close');
    }
  }

  onOpenBookmark(bm: FileBrowserItem): void {
    this.bookmarkOpened.emit(bm);
    if (this.isMobile) {
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
    if (this.starredMode || !this.nautilusRemote) return false;
    const bmRemote = (bm.meta.remote ?? '').replace(/:$/, '');
    return this.nautilusRemote.name === bmRemote && this.currentPath === bm.entry.Path;
  }

  /** Returns true when any bookmark matches the current location (so remotes should not show selected). */
  isAnyBookmarkSelected(): boolean {
    return this.bookmarks.some(bm => this.isBookmarkSelected(bm));
  }

  // Helper for cleanup support
  supportsCleanup(remote: ExplorerRoot | null): boolean {
    if (!remote) return false;
    return this.cleanupSupportCache[remote.name] ?? false;
  }
}
