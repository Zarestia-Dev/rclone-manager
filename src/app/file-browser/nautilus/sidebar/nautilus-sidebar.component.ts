import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslatePipe } from '@ngx-translate/core';
import { MatIconModule } from '@angular/material/icon';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CdkMenuModule } from '@angular/cdk/menu';

import { MatDialog } from '@angular/material/dialog';
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { FileBrowserItem, ExplorerRoot, STANDARD_MODAL_SIZE } from '@app/types';
import { OperationsPanelComponent } from '../../operations-panel/operations-panel.component';
import { SlideMenuController } from '../slide-menu';
import { NautilusSettingsService } from 'src/app/services/ui/nautilus-settings.service';
import {
  ItemOrderVisibilityModalComponent,
  ItemOrderVisibilityConfigItem,
  ItemOrderVisibilityResult,
} from 'src/app/features/modals/item-order-visibility-modal/item-order-visibility-modal.component';

interface BookmarkViewModel {
  bm: FileBrowserItem;
  key: string;
}

function sortAndFilterRoots(
  roots: ExplorerRoot[],
  hidden: Set<string>,
  order: string[]
): ExplorerRoot[] {
  const visible = roots.filter(r => !hidden.has(r.name));
  if (!order.length) return visible;

  const orderMap = new Map<string, number>(order.map((name, i) => [name, i]));
  return visible.sort((a, b) => (orderMap.get(a.name) ?? 9999) - (orderMap.get(b.name) ?? 9999));
}

@Component({
  selector: 'app-nautilus-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    TranslatePipe,
    MatIconModule,
    MatToolbarModule,
    MatDividerModule,
    MatTooltipModule,
    CdkMenuModule,
    OperationsPanelComponent,
  ],
  templateUrl: './nautilus-sidebar.component.html',
  styleUrl: './nautilus-sidebar.component.scss',
})
export class NautilusSidebarComponent {
  readonly iconService = inject(IconService);
  private readonly pathService = inject(PathService);
  private readonly remoteFacadeService = inject(RemoteFacadeService);
  protected readonly settings = inject(NautilusSettingsService);
  private readonly dialog = inject(MatDialog);

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

  // Context menu sliding controller
  protected readonly menuCtrl = new SlideMenuController('.sidebar-sliding-container');

  // Computed
  private readonly _activeKey = computed<string | null>(() => {
    const remote = this.nautilusRemote();
    if (this.starredMode() || !remote) return null;
    return `${remote.name}::${this.currentPath()}`;
  });

  readonly anyBookmarkSelected = computed(() => {
    const active = this._activeKey();
    return active !== null && this.bookmarks().some(bm => this._bookmarkKey(bm) === active);
  });

  readonly bookmarkViewModels = computed<BookmarkViewModel[]>(() =>
    this.bookmarks().map(bm => ({ bm, key: this._bookmarkKey(bm) }))
  );

  readonly selectedBookmarkKeys = computed<Set<string>>(() => {
    const active = this._activeKey();
    if (active === null) return new Set<string>();
    const keys = this.bookmarkViewModels().map(vm => vm.key);
    return new Set<string>(keys.filter(key => key === active));
  });

  readonly displayLocalDrives = computed<ExplorerRoot[]>(() =>
    sortAndFilterRoots(
      this.localDrives(),
      this.settings.sidebarHiddenDrives(),
      this.settings.sidebarDriveOrder()
    )
  );

  readonly displayCloudRemotes = computed<ExplorerRoot[]>(() =>
    sortAndFilterRoots(
      this.cloudRemotes(),
      this.settings.sidebarHiddenDrives(),
      this.settings.sidebarDriveOrder()
    )
  );

  readonly cleanupSupportedRemotes = computed<Set<string>>(() => {
    const result = new Set<string>();
    for (const remote of [...this.displayLocalDrives(), ...this.displayCloudRemotes()]) {
      if (this.remoteFacadeService.featuresSignal(remote.name)().CleanUp) {
        result.add(remote.name);
      }
    }
    return result;
  });

  readonly driveTooltips = computed<Map<string, string>>(() => {
    const map = new Map<string, string>();
    for (const drive of [...this.displayLocalDrives(), ...this.displayCloudRemotes()]) {
      const pathInfo = drive.name ? `${drive.name}\n` : '';
      if (drive.totalSpace === undefined || drive.totalSpace === 0) {
        map.set(drive.name, pathInfo);
        continue;
      }
      const fs = drive.fileSystem ? ` [${drive.fileSystem}]` : '';
      map.set(drive.name, `${pathInfo}${fs}`);
    }
    return map;
  });

  onConfigureSidebar(): void {
    const all = [...this.localDrives(), ...this.cloudRemotes()];
    const hidden = this.settings.sidebarHiddenDrives();
    const order = this.settings.sidebarDriveOrder();

    const orderMap = new Map<string, number>(order.map((name, i) => [name, i]));
    const sortedAll = [...all].sort(
      (a, b) => (orderMap.get(a.name) ?? 9999) - (orderMap.get(b.name) ?? 9999)
    );

    const items: ItemOrderVisibilityConfigItem[] = sortedAll.map(root => ({
      id: root.name,
      label: root.label || root.name,
      subLabel: root.showName && root.label !== root.name ? root.name : undefined,
      icon: root.isLocal ? 'hard-drive' : this.iconService.getIconName(root.type),
      isVisible: !hidden.has(root.name),
    }));

    const defaultItems: ItemOrderVisibilityConfigItem[] = all.map(root => ({
      id: root.name,
      label: root.label || root.name,
      subLabel: root.showName && root.label !== root.name ? root.name : undefined,
      icon: root.isLocal ? 'hard-drive' : this.iconService.getIconName(root.type),
      isVisible: true,
    }));

    this.dialog
      .open(ItemOrderVisibilityModalComponent, {
        ...STANDARD_MODAL_SIZE,
        disableClose: true,
        data: {
          title: 'nautilus.sidebar.configureTitle',
          description: 'nautilus.sidebar.configureDescription',
          mode: 'visibility',
          iconHeader: 'tune',
          items,
          defaultItems,
        },
        panelClass: 'mobile-sheet-dialog',
      })
      .afterClosed()
      .subscribe((result: ItemOrderVisibilityResult | undefined) => {
        if (result) {
          if (result.isReset) {
            this.settings.saveSidebarConfig([], []);
          } else {
            const newOrder = result.items.map(i => i.id);
            const newHidden = result.hiddenIds;
            this.settings.saveSidebarConfig(newOrder, newHidden);
          }
        }
      });
  }

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

  private _bookmarkKey(bm: FileBrowserItem): string {
    const remote = this.pathService.normalizeRemoteName(bm.meta.remote ?? '');
    return `${remote}::${bm.entry.Path}`;
  }

  private _closeSidenavOnMobile(): void {
    if (this.isMobile()) this.sidenavAction.emit('close');
  }
}
