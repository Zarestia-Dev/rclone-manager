import {
  Component,
  EventEmitter,
  inject,
  Output,
  OnInit,
  OnDestroy,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { BehaviorSubject, combineLatest, Subject, of, from, concat } from 'rxjs';
import { take, switchMap, catchError, map, finalize, takeUntil } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatButtonModule } from '@angular/material/button';
import { MatGridListModule } from '@angular/material/grid-list';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FormsModule } from '@angular/forms';
import { AnimationsService } from '../../shared/services/animations.service';
import {
  UiStateService,
  WindowService,
  RemoteManagementService,
  MountManagementService,
  FilePickerOptions,
} from '@app/services';
import { Entry } from '@app/types';
import { IconService } from '../../shared/services/icon.service';

@Component({
  selector: 'app-nautilus',
  standalone: true,
  imports: [
    CommonModule,
    MatListModule,
    MatIconModule,
    MatToolbarModule,
    MatSidenavModule,
    MatButtonModule,
    MatGridListModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatRadioModule,
    MatCheckboxModule,
    FormsModule,
  ],
  templateUrl: './nautilus.component.html',
  styleUrl: './nautilus.component.scss',
  animations: [AnimationsService.slideOverlay()],
})
export class NautilusComponent implements OnInit, OnDestroy {
  uiStateService = inject(UiStateService);
  windowService = inject(WindowService);
  private remoteManagement = inject(RemoteManagementService);
  private mountManagement = inject(MountManagementService);
  public remotes$ = this.remoteManagement.remotes$;
  private remoteConfigs$ = new BehaviorSubject<Record<string, unknown>>({});
  public mountedRemotes$ = this.mountManagement.mountedRemotes$;

  public remotesWithMeta$ = combineLatest([
    this.remotes$,
    this.remoteConfigs$,
    this.mountedRemotes$,
  ]).pipe(
    map(([names, configs, mountedRemotes]) => {
      const remoteList = (names || []).map(name => {
        const mountedInfo = mountedRemotes.find(mr => mr.fs.replace(/:$/, '') === name);
        return {
          name,
          type: ((): string | undefined => {
            const cfg = configs?.[name] as Record<string, unknown> | undefined;
            return (
              (cfg && (cfg['type'] as string | undefined)) ||
              (cfg && (cfg['Type'] as string | undefined)) ||
              undefined
            );
          })(),
          isMounted: !!mountedInfo,
          mountPoint: mountedInfo?.mount_point,
        };
      });
      remoteList.unshift({ name: 'Local', type: 'home', isMounted: false, mountPoint: undefined });
      return remoteList;
    })
  );
  readonly iconService = inject(IconService);
  public nautilusRemote$ = new BehaviorSubject<{ name: string; type?: string } | null>(null);
  private destroy$ = new Subject<void>();
  windowButtons = true;

  private isLoading = new BehaviorSubject<boolean>(false);
  public isLoading$ = this.isLoading.asObservable();
  private cancelLoading$ = new Subject<void>();
  private selectedItems = new BehaviorSubject<Set<string>>(new Set());
  public selectedItems$ = this.selectedItems.asObservable();
  private lastSelectedIndex: number | null = null;
  private pathHistory: string[] = [''];
  private currentHistoryIndex = 0;
  public isEditingPath = new BehaviorSubject<boolean>(false);
  public currentPath$ = new BehaviorSubject<string>('');
  public pathSegments$ = this.currentPath$.pipe(map(path => path.split('/').filter(p => p)));
  public selectionSummary$ = new BehaviorSubject<string>('');
  public isPickerMode$ = new BehaviorSubject<boolean>(false);
  public pickerOptions: FilePickerOptions = {};
  public title$ = new BehaviorSubject<string>('Files');

  public layout$ = new BehaviorSubject<'grid' | 'list'>('grid');
  public sort$ = new BehaviorSubject<{ key: string; direction: 'asc' | 'desc' }>({
    key: 'name',
    direction: 'asc',
  });
  public showHidden$ = new BehaviorSubject<boolean>(false);
  public iconSize$ = new BehaviorSubject<number>(120);

  private currentFiles: Entry[] = [];

  private rawFiles$ = combineLatest([this.nautilusRemote$, this.currentPath$]).pipe(
    switchMap(([remote, path]) => {
      Promise.resolve().then(() => this.isLoading.next(true));
      if (remote?.name) {
        const remoteName = remote.name === 'Local' ? '' : remote.name;
        const filesRequest$ = from(this.remoteManagement.getRemotePaths(remoteName, path, {})).pipe(
          takeUntil(this.cancelLoading$),
          catchError(err => {
            console.error('Error fetching remote paths:', err);
            return of({ list: [] as Entry[] });
          })
        );
        return concat(of({ list: [] as Entry[] }), filesRequest$).pipe(
          finalize(() => Promise.resolve().then(() => this.isLoading.next(false)))
        );
      }
      Promise.resolve().then(() => this.isLoading.next(false));
      return of({ list: [] as Entry[] });
    }),
    map(response => response.list)
  );

  public files$ = combineLatest([this.rawFiles$, this.sort$, this.showHidden$]).pipe(
    map(([files, sort, showHidden]) => {
      // 1. Filter
      const processedFiles = showHidden ? files : files.filter(f => !f.Name.startsWith('.'));

      // 2. Sort
      processedFiles.sort((a, b) => {
        // Directories first
        if (a.IsDir && !b.IsDir) return -1;
        if (!a.IsDir && b.IsDir) return 1;

        const dir = sort.direction === 'asc' ? 1 : -1;

        switch (sort.key) {
          case 'name':
            return a.Name.localeCompare(b.Name) * dir;
          case 'modified':
            return (new Date(a.ModTime).getTime() - new Date(b.ModTime).getTime()) * dir;
          case 'size':
            return (a.Size - b.Size) * dir;
          default:
            return a.Name.localeCompare(b.Name) * dir; // default to a-z
        }
      });
      return processedFiles;
    })
  );

  @Output() closeOverlay = new EventEmitter<void>();

  @ViewChild('pathInput') set pathInput(element: ElementRef<HTMLInputElement>) {
    if (element) {
      element.nativeElement.focus();
      element.nativeElement.select();
    }
  }

  constructor() {
    this.rawFiles$.pipe(takeUntil(this.destroy$)).subscribe(files => {
      this.currentFiles = files;
    });
    this.uiStateService.filePickerState$.subscribe(state => {
      this.isPickerMode$.next(state.isOpen);
      if (state.isOpen && state.options) {
        this.pickerOptions = state.options;
        this.title$.next(state.options.selectFolders ? 'Select Folder' : 'Select Files');
      } else {
        this.title$.next('Files');
      }
    });
    if (this.uiStateService.platform === 'macos' || this.uiStateService.platform === 'web') {
      this.windowButtons = false;
    }
    console.log('Nautilus ngOnInit called, picker mode:', this.isPickerMode$.value);
  }

  confirmSelection(): void {
    let selectedPaths = Array.from(this.selectedItems.getValue());
    const remote = this.nautilusRemote$.getValue();

    if (selectedPaths.length === 0 && this.pickerOptions.selectFolders) {
      selectedPaths = [this.currentPath$.getValue()];
    }

    if (remote && remote.name !== 'Local') {
      const fullPaths = selectedPaths.map(path => `${remote.name}:${path}`);
      this.uiStateService.closeFilePicker(fullPaths);
    } else {
      this.uiStateService.closeFilePicker(selectedPaths);
    }
  }

  isItemSelectable(item: Entry): boolean {
    if (!this.isPickerMode$.value) {
      // Not in picker mode, so no selection restrictions apply.
      return true;
    }
    if (this.pickerOptions.selectFolders && !item.IsDir) {
      // In folder selection mode, files are not selectable.
      return false;
    }
    if (this.pickerOptions.selectFiles && item.IsDir) {
      // In file selection mode, folders are not selectable but still navigable.
      return false;
    }
    return true;
  }

  get isOpenDisabled(): boolean {
    const selected = this.selectedItems.getValue();

    if (selected.size === 0) {
      return !this.pickerOptions.selectFolders;
    }

    // If multiSelection is false, ensure only one item is selected
    if (this.pickerOptions.multiSelection === false && selected.size > 1) {
      return true;
    }

    const allFiles: Entry[] = this.currentFiles;

    for (const path of selected) {
      const item = allFiles.find((i: Entry) => i.Path === path);
      if (!item) {
        return true; // Should not happen, but good to be safe
      }

      if (item.IsDir && !this.pickerOptions.selectFolders) {
        return true; // A folder is selected, but we only want files
      }

      if (!item.IsDir && !this.pickerOptions.selectFiles) {
        return true; // A file is selected, but we only want folders
      }
    }

    return false; // All selections are valid
  }

  changeSort(key: string): void {
    const currentSort = this.sort$.getValue();
    if (currentSort.key === key) {
      this.sort$.next({ key, direction: currentSort.direction === 'asc' ? 'desc' : 'asc' });
    } else {
      this.sort$.next({ key, direction: 'asc' });
    }
  }

  formatRelativeDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const diffDays = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return `Today, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (diffDays === 1) {
      return `Yesterday, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (diffDays < 7) {
      return `${diffDays} days ago`;
    }
    return date.toLocaleDateString();
  }

  setLayout(layout: 'grid' | 'list'): void {
    this.layout$.next(layout);
  }

  toggleShowHidden(checked: boolean): void {
    this.showHidden$.next(checked);
  }

  increaseIconSize(): void {
    this.iconSize$.next(Math.min(this.iconSize$.value + 20, 240));
  }

  decreaseIconSize(): void {
    this.iconSize$.next(Math.max(this.iconSize$.value - 20, 80));
  }

  clearSelection(): void {
    this.selectedItems.next(new Set());
    this.selectionSummary$.next('');
    this.lastSelectedIndex = null;
  }

  onItemKeydown(item: Entry, event: Event, index: number, allItems: Entry[] | null): void {
    if (event instanceof KeyboardEvent && event.key === 'Enter') {
      const mockMouseEvent = new MouseEvent('click', {
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
      });
      this.onItemClick(item, mockMouseEvent, index, allItems);
    }
  }

  private updateSelectionSummary(selectedPaths: Set<string>, allItems: Entry[] | null): void {
    if (!allItems || selectedPaths.size === 0) {
      this.selectionSummary$.next('');
      return;
    }

    if (selectedPaths.size === 1) {
      const selectedPath = selectedPaths.values().next().value;
      const selectedItem = allItems.find(item => item.Path === selectedPath);

      if (selectedItem) {
        if (selectedItem.IsDir) {
          this.selectionSummary$.next(`"${selectedItem.Name}" selected`);
        } else {
          this.selectionSummary$.next(
            `"${selectedItem.Name}" selected (${this.formatBytes(selectedItem.Size)})`
          );
        }
      }
    } else {
      this.selectionSummary$.next(`${selectedPaths.size} items selected`);
    }
    console.log('Selection summary updated:', this.selectionSummary$.value);
  }

  public formatBytes(bytes: number, decimals = 1): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  async openMountInFiles(
    event: MouseEvent,
    mountPoint: string | undefined,
    remoteName: string
  ): Promise<void> {
    event.stopPropagation();
    if (mountPoint) {
      await this.mountManagement.unmountRemote(mountPoint, remoteName);
    }
  }

  onClose(): void {
    if (this.isPickerMode$.value) {
      this.uiStateService.closeFilePicker(null);
    } else {
      this.closeOverlay.emit();
    }
  }

  cancelLoad(): void {
    this.cancelLoading$.next();
  }

  // A back button for standalone web mode
  goBack(): void {
    if (this.currentHistoryIndex > 0) {
      this.currentHistoryIndex--;
      this.currentPath$.next(this.pathHistory[this.currentHistoryIndex]);
      this.selectedItems.next(new Set());
      this.selectionSummary$.next('');
      this.lastSelectedIndex = null;
    }
  }

  goForward(): void {
    if (this.currentHistoryIndex < this.pathHistory.length - 1) {
      this.currentHistoryIndex++;
      this.currentPath$.next(this.pathHistory[this.currentHistoryIndex]);
      this.selectedItems.next(new Set());
      this.selectionSummary$.next('');
      this.lastSelectedIndex = null;
    }
  }

  async minimizeWindow(): Promise<void> {
    await this.windowService.minimize();
  }

  async maximizeWindow(): Promise<void> {
    await this.windowService.maximize();
  }

  async closeWindow(): Promise<void> {
    await this.windowService.close();
  }

  // TrackBy helpers
  trackByIndex(index: number): number {
    return index;
  }

  trackByRemote(_: number, item: { name: string; type?: string }): string {
    return item?.name || String(_);
  }

  trackByFile(_: number, item: Entry): string {
    return item.ID || item.Path;
  }

  onItemClick(item: Entry, event: MouseEvent, index: number, allItems: Entry[] | null): void {
    event.stopPropagation();
    if (!allItems || (this.isPickerMode$.value && !this.isItemSelectable(item))) {
      return;
    }
    const currentSelection = new Set(this.selectedItems.getValue());
    const isMultiSelectAllowed =
      !this.isPickerMode$.value || this.pickerOptions.multiSelection !== false;

    console.log(
      'Item clicked:',
      item,
      'Event:',
      event,
      'Index:',
      index,
      'Multi-select allowed:',
      isMultiSelectAllowed
    );

    if (event.shiftKey && this.lastSelectedIndex !== null && isMultiSelectAllowed) {
      currentSelection.clear();
      const start = Math.min(this.lastSelectedIndex, index);
      const end = Math.max(this.lastSelectedIndex, index);
      for (let i = start; i <= end; i++) {
        currentSelection.add(allItems[i].Path);
      }
      console.log('Shift selection range:', start, 'to', end);
    } else if (event.ctrlKey && isMultiSelectAllowed) {
      if (currentSelection.has(item.Path)) {
        currentSelection.delete(item.Path);
      } else {
        currentSelection.add(item.Path);
      }
      this.lastSelectedIndex = index;
    } else {
      currentSelection.clear();
      currentSelection.add(item.Path);
      this.lastSelectedIndex = index;
    }
    this.selectedItems.next(currentSelection);
    this.updateSelectionSummary(currentSelection, allItems);
    console.log('Selected items:', Array.from(currentSelection));
  }

  navigateTo(item: Entry): void {
    if (item.IsDir) {
      this.updatePath(item.Path);
    }
  }

  navigateToPath(path: string): void {
    this.isEditingPath.next(false);
    const currentRemote = this.nautilusRemote$.getValue();

    if (currentRemote?.name === 'Local') {
      this.updatePath(path);
      return;
    }

    this.remotesWithMeta$.pipe(take(1)).subscribe(remotes => {
      const parts = path.split('/');
      const potentialRemoteName = parts[0];
      const remote = remotes.find(r => r.name === potentialRemoteName);

      if (remote) {
        // A remote name is at the start of the path
        const newPath = parts.slice(1).join('/');
        if (currentRemote?.name !== remote.name) {
          this.selectRemote(remote);
        }
        this.updatePath(newPath);
      } else {
        // No remote name, assume it's a path relative to current remote
        this.updatePath(path);
      }
    });
  }

  getPath(segments: string[] | null, index: number): string {
    if (!segments) {
      return '';
    }
    return segments.slice(0, index + 1).join('/');
  }

  private updatePath(newPath: string): void {
    this.currentPath$.next(newPath);
    this.selectedItems.next(new Set());
    this.selectionSummary$.next('');
    this.lastSelectedIndex = null;
    // Clear forward history
    this.pathHistory.splice(this.currentHistoryIndex + 1);
    this.pathHistory.push(newPath);
    this.currentHistoryIndex++;
  }

  selectRemote(remote: { name: string; type?: string }): void {
    this.nautilusRemote$.next(remote);
    this.currentPath$.next('');
    this.selectedItems.next(new Set());
    this.lastSelectedIndex = null;
    this.pathHistory = [''];
    this.currentHistoryIndex = 0;
    this.selectionSummary$.next('');
  }

  async ngOnInit(): Promise<void> {
    // Load remotes on component init. This will call into the Tauri backend
    // — if this is running in tests, a mock service should be provided to
    // avoid invoking native commands.
    try {
      await this.remoteManagement.getRemotes();
      await this.mountManagement.getMountedRemotes();
      // Try to load remote configuration metadata (type, etc) so we can show icons
      try {
        const configs = await this.remoteManagement.getAllRemoteConfigs();
        this.remoteConfigs$.next(configs || {});
      } catch (err) {
        // Keep going without remote type metadata
        console.warn('Failed to load remote configs for Nautilus icons', err);
      }

      // Ensure a default selected remote if the UI has none and there are remotes available
      this.uiStateService.selectedRemote$.pipe(take(1)).subscribe(currentSelected => {
        if (currentSelected) {
          this.nautilusRemote$.next(currentSelected.remoteSpecs);
        } else {
          const localRemote = { name: 'Local', type: 'local' };
          this.nautilusRemote$.next(localRemote);
        }
      });
    } catch (error) {
      // On failure, there is nothing we can do in the UI here. Logging kept
      // to a minimum; the service will already log any CLI errors.
      // Keep component resilient to service failures.
      console.warn('Failed to fetch remotes', error);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
