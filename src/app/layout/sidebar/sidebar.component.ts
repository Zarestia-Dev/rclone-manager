import { TitleCasePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { SearchContainerComponent } from '../../shared/components/search-container/search-container.component';

import { MountedRemote, OPERATION_REGISTRY, QuickRun, Remote, ServeListItem } from '@app/types';

import { IconService } from 'src/app/services/ui/icon.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { RemoteStatusService } from 'src/app/services/remote/remote-status.service';
import { RemoteFacadeService } from '../../services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';

export type SidebarMode = 'remotes' | 'flow';

@Component({
  selector: 'app-sidebar',
  imports: [TitleCasePipe, MatCardModule, MatIconModule, TranslatePipe, SearchContainerComponent],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SidebarComponent {
  readonly mode = input<SidebarMode>('remotes');
  readonly customTitle = input<string>();
  readonly customIcon = input<string>();
  readonly remotes = input<Remote[]>([]);
  readonly itemSelected = output<void>();

  readonly iconService = inject(IconService);
  readonly statusService = inject(RemoteStatusService);
  private readonly uiStateService = inject(UiStateService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly quickRunService = inject(QuickRunService);
  private readonly pathService = inject(PathService);

  readonly title = computed(
    () => this.customTitle() ?? (this.mode() === 'flow' ? 'flow.quickRun.title' : 'sidebar.remotes')
  );
  readonly icon = computed(
    () => this.customIcon() ?? (this.mode() === 'flow' ? 'operations' : 'server')
  );
  readonly searchPlaceholder = computed(() =>
    this.mode() === 'flow' ? 'flow.quickRun.search' : 'sidebar.searchPlaceholder'
  );
  readonly searchAriaLabel = computed(() =>
    this.mode() === 'flow' ? 'flow.quickRun.search' : 'sidebar.searchAriaLabel'
  );
  readonly toggleSearchTitle = computed(() =>
    this.mode() === 'flow' ? 'flow.quickRun.toggleSearch' : 'sidebar.toggleSearch'
  );

  // ── Unified loading & empty states ────────────────────────────────────────
  readonly isLoading = computed(() => {
    if (this.mode() === 'remotes') {
      return this.remoteFacade.loading();
    }
    return this.quickRunService.isLoading();
  });

  readonly hasAny = computed(() => {
    if (this.mode() === 'remotes') {
      return this.remotes().length > 0;
    }
    return this.quickRuns().length > 0;
  });

  readonly emptyIcon = computed(() => (this.mode() === 'flow' ? 'operations' : 'server'));
  readonly emptyText = computed(() =>
    this.mode() === 'flow' ? 'flow.quickRun.empty.description' : 'sidebar.noRemotesConfigured'
  );
  readonly loadingText = computed(() =>
    this.mode() === 'flow' ? 'flow.quickRun.loading' : 'common.loading'
  );

  // ── Remotes state ─────────────────────────────────────────────────────────
  readonly selectedRemote = this.uiStateService.selectedRemote;
  readonly hiddenRemotesSet = computed(() => new Set(this.remoteFacade.hiddenRemoteNames()));

  // ── Quick-run state ───────────────────────────────────────────────────────
  readonly quickRuns = this.quickRunService.quickRuns;
  readonly selectedQuickRunId = this.quickRunService.selectedId;
  readonly runningIds = this.quickRunService.runningIds;
  readonly mountedRemotes = this.remoteFacade.mountedRemotes;
  readonly runningServes = this.remoteFacade.runningServes;

  // ── Search & Filter state ─────────────────────────────────────────────────
  readonly searchTerm = signal('');
  readonly searchVisible = signal(false);
  private readonly searchContainer = viewChild(SearchContainerComponent);

  readonly filteredRemotes = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    if (!term) return this.remotes();
    return this.remotes().filter(
      r => r.name.toLowerCase().includes(term) || r.type.toLowerCase().includes(term)
    );
  });

  readonly filteredQuickRuns = computed(() => {
    const query = this.searchTerm().toLowerCase().trim();
    if (!query) return this.quickRuns();
    return this.quickRuns().filter(qr => this.matchesQuickRunQuery(qr, query));
  });

  // ── Remotes actions ───────────────────────────────────────────────────────
  selectRemote(remote: Remote): void {
    this.uiStateService.setSelectedRemote(remote);
    this.itemSelected.emit();
  }

  // ── Quick-run actions ─────────────────────────────────────────────────────
  selectQuickRun(id: string): void {
    this.quickRunService.select(id);
    this.itemSelected.emit();
  }

  isQuickRunRunning(id: string): boolean {
    const qr = this.quickRuns().find(q => q.id === id);
    if (!qr) return this.runningIds().has(id);

    if (qr.operationType === 'mount') {
      const mountPoint = (qr.config?.rclone as Record<string, unknown> | undefined)?.[
        'mountPoint'
      ] as string | undefined;
      return this.mountedRemotes().some(
        (m: MountedRemote) =>
          m.profile === qr.name ||
          (this.pathService.getRemoteNameFromFs(m.fs) === qr.remoteName &&
            !!m.mount_point &&
            m.mount_point === mountPoint)
      );
    }
    if (qr.operationType === 'serve') {
      return this.runningServes().some(
        (s: ServeListItem) =>
          s.profile === qr.name ||
          this.pathService.getRemoteNameFromFs(s.params?.fs) === qr.remoteName
      );
    }
    return this.runningIds().has(id) || qr.status === 'running';
  }

  getQuickRunIcon(qr: QuickRun): string {
    const def = OPERATION_REGISTRY.find(d => d.key === qr.operationType);
    return def?.icon ?? 'operations';
  }

  getQuickRunActionLabel(qr: QuickRun): string {
    const def = OPERATION_REGISTRY.find(d => d.key === qr.operationType);
    return def?.actionLabel ?? 'flow.tabs.quickRun';
  }

  getQuickRunStatusClass(qr: QuickRun): string {
    return this.isQuickRunRunning(qr.id) ? 'running' : qr.status;
  }

  hasCron(qr: QuickRun): boolean {
    const app = qr.config?.app;
    return !!(app?.cronEnabled && app?.cronExpression);
  }

  hasWatcher(qr: QuickRun): boolean {
    return !!qr.config?.app?.watchEnabled;
  }

  hasAutoStart(qr: QuickRun): boolean {
    return !!qr.config?.app?.autoStart;
  }

  trackByQuickRunId(_index: number, qr: QuickRun): string {
    return qr.id;
  }

  private matchesQuickRunQuery(qr: QuickRun, query: string): boolean {
    const rclone = (qr.config.rclone ?? {}) as Record<string, unknown>;
    const opType = qr.operationType;
    const opData = (rclone[opType] as Record<string, unknown> | undefined) ?? rclone;
    const haystack = [
      qr.name,
      qr.description ?? '',
      qr.remoteName,
      qr.operationType,
      opData['srcFs'] ? String(opData['srcFs']) : rclone['srcFs'] ? String(rclone['srcFs']) : '',
      opData['dstFs'] ?? rclone['dstFs'] ?? '',
      opData['path1'] ?? rclone['path1'] ?? '',
      opData['path2'] ?? rclone['path2'] ?? '',
      opData['mountPoint'] ?? rclone['mountPoint'] ?? '',
      opData['fs'] ?? rclone['fs'] ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  }

  // ── Common search methods ─────────────────────────────────────────────────
  onSearchTextChange(text: string): void {
    this.searchTerm.set(text);
  }

  toggleSearch(): void {
    this.searchVisible.update(v => !v);
    if (!this.searchVisible()) {
      this.clearSearch();
    }
  }

  clearSearch(): void {
    this.searchTerm.set('');
    this.searchContainer()?.clear();
  }
}
