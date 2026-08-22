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

import { OPERATION_REGISTRY, QuickRun, Remote } from '@app/types';

import { IconService } from 'src/app/services/ui/icon.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';
import { RemoteStatusService } from 'src/app/services/remote/remote-status.service';
import { RemoteFacadeService } from '../../services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';

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

  readonly title = computed(
    () => this.customTitle() ?? (this.mode() === 'flow' ? 'flow.title' : 'sidebar.remotes')
  );
  readonly icon = computed(() => this.customIcon() ?? (this.mode() === 'flow' ? 'flow' : 'server'));
  readonly searchPlaceholder = computed(() =>
    this.mode() === 'flow' ? 'flow.search' : 'sidebar.searchPlaceholder'
  );
  readonly searchAriaLabel = computed(() =>
    this.mode() === 'flow' ? 'flow.search' : 'sidebar.searchAriaLabel'
  );
  readonly toggleSearchTitle = computed(() =>
    this.mode() === 'flow' ? 'flow.toggleSearch' : 'sidebar.toggleSearch'
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

  readonly emptyIcon = computed(() => (this.mode() === 'flow' ? 'flow' : 'server'));
  readonly emptyText = computed(() =>
    this.mode() === 'flow' ? 'flow.empty.description' : 'sidebar.noRemotesConfigured'
  );
  readonly loadingText = computed(() =>
    this.mode() === 'flow' ? 'flow.loading' : 'common.loading'
  );

  // ── Remotes state ─────────────────────────────────────────────────────────
  readonly selectedRemote = this.uiStateService.selectedRemote;
  readonly hiddenRemotesSet = computed(() => new Set(this.remoteFacade.hiddenRemoteNames()));

  // ── Quick-run state ───────────────────────────────────────────────────────
  readonly quickRuns = this.quickRunService.quickRuns;
  readonly selectedQuickRunId = this.quickRunService.selectedId;
  readonly runningIds = this.quickRunService.runningIds;

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
    return this.runningIds().has(id);
  }

  getQuickRunIcon(qr: QuickRun): string {
    const def = OPERATION_REGISTRY.find(d => d.key === qr.operationType);
    return def?.icon ?? 'operations';
  }

  getQuickRunActionLabel(qr: QuickRun): string {
    const def = OPERATION_REGISTRY.find(d => d.key === qr.operationType);
    return def?.actionLabel ?? 'flow.tabs.quickRun';
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
