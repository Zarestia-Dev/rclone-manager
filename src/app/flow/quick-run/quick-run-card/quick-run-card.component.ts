import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import {
  getQuickRunPaths,
  OpenInFilesEvent,
  OPERATION_REGISTRY,
  QuickRun,
  QuickRunStatus,
  isFolderOpeningAction,
} from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';

export interface QuickRunOpenableFolder {
  type: 'source' | 'destination';
  path: string;
  isLocal: boolean;
  icon: string;
  cssClass: string;
  tooltip: string;
}

/**
 * A card component for Quick Runs, supporting two visual variants:
 *  - 'sidebar': Compact item designed for the Flow sidebar list.
 *  - 'overview': Dashboard card with direct Start/Stop, Edit, and Browse actions.
 */
@Component({
  selector: 'app-quick-run-card',
  imports: [MatButtonModule, MatCardModule, MatIconModule, CdkMenuModule, TranslatePipe],
  templateUrl: './quick-run-card.component.html',
  styleUrls: ['./quick-run-card.component.scss', '../../../styles/_shared-card.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.overview-variant]': 'variant() === "overview"',
    '[class.sidebar-variant]': 'variant() === "sidebar"',
    '[class.is-running]': 'isRunning()',
    '[class.selected]': 'selected()',
    '[class]': 'cardOperationClass()',
    '(click)': 'variant() === "overview" ? onRowClick() : null',
  },
})
export class QuickRunCardComponent {
  readonly pathService = inject(PathService);
  readonly iconService = inject(IconService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly quickRunService = inject(QuickRunService);
  private readonly translate = inject(TranslateService);

  /** The quick run this card represents. */
  readonly quickRun = input.required<QuickRun>();
  /** True if this card is currently selected (drives highlight). */
  readonly selected = input<boolean>(false);
  /** True if the quick run is currently running (drives status dot/badge). */
  readonly isRunning = input<boolean>(false);
  /** Visual variant: 'sidebar' for compact list, 'overview' for dashboard card grid. */
  readonly variant = input<'sidebar' | 'overview'>('sidebar');

  /** Emitted when the card is clicked (selects quick run for detail view). */
  readonly selectedChange = output<string>();
  /** Emitted when the Start action button is clicked (overview variant). */
  readonly startRun = output<QuickRun>();
  /** Emitted when the Stop action button is clicked (overview variant). */
  readonly stopRun = output<QuickRun>();
  /** Emitted when the Edit action button is clicked (overview variant). */
  readonly editRun = output<QuickRun>();
  /** Emitted when a Folder browse action button is clicked. */
  readonly openInFiles = output<OpenInFilesEvent>();
  /** Emitted when the Remote name link is clicked to open full remote details. */
  readonly openRemoteDetail = output<string>();

  // ── Reactive In-flight States ─────────────────────────────────────────────
  readonly isActionInProgress = computed<boolean>(
    () => !!this.quickRunService.actionInProgress()[this.quickRun().id]
  );
  readonly actionStates = computed(
    () => this.remoteFacade.actionInProgress()[this.quickRun().remoteName] ?? []
  );
  readonly isFolderOpening = computed<boolean>(() => isFolderOpeningAction(this.actionStates()));

  // ── Derived view model ────────────────────────────────────────────────────

  readonly operationDef = computed(() => {
    const op = this.quickRun().operationType;
    return OPERATION_REGISTRY.find(d => d.key === op);
  });

  readonly remote = computed(() =>
    this.remoteFacade.orderedRemotes().find(r => r.name === this.quickRun().remoteName)
  );

  readonly remoteIcon = computed(() => {
    const rem = this.remote();
    return rem ? this.iconService.getIconName(rem.type) : 'cloud';
  });

  readonly icon = computed(() => this.operationDef()?.icon ?? 'operations');
  readonly actionLabel = computed(() => this.operationDef()?.actionLabel ?? 'Start');
  readonly cardOperationClass = computed(() => `op-${this.quickRun().operationType}`);

  /** Dynamic action button icon based on operation definition and active status. */
  readonly currentActionIcon = computed(() => {
    if (this.isRunning()) {
      return this.operationDef()?.stopIcon ?? 'stop';
    }
    return this.operationDef()?.startIcon ?? this.icon();
  });

  /** Dynamic action button tooltip based on operation definition and active status. */
  readonly currentActionTooltip = computed(() => {
    if (this.isRunning()) {
      const key = this.operationDef()?.stopTooltip;
      return key
        ? this.translate.instant(key)
        : this.translate.instant('flow.quickRun.actions.stop');
    }
    const key = this.operationDef()?.startTooltip;
    return key
      ? this.translate.instant(key)
      : this.translate.instant('flow.quickRun.actions.start');
  });

  /** Status badge metadata (label + color class). */
  readonly statusBadge = computed<{ cssClass: QuickRunStatus }>(() => {
    const status: QuickRunStatus = this.isRunning() ? 'running' : this.quickRun().status;
    return { cssClass: status };
  });

  /** Feature indicators (Cron schedule, File Watcher, AutoStart). */
  readonly hasCron = computed(() => {
    const app = this.quickRun().config?.app;
    return !!(app?.cronEnabled && app?.cronExpression);
  });

  readonly cronExpression = computed(() => this.quickRun().config?.app?.cronExpression ?? '');

  readonly hasWatcher = computed(() => {
    const app = this.quickRun().config?.app;
    return !!app?.watchEnabled;
  });

  readonly hasWatchChangedOnly = computed(() => {
    const app = this.quickRun().config?.app;
    return !!app?.watchChangedOnly;
  });

  readonly hasAutoStart = computed(() => {
    const app = this.quickRun().config?.app;
    return !!app?.autoStart;
  });

  /** All browsable folder targets (both source and destination) for this quick run. */
  readonly openableFolders = computed<QuickRunOpenableFolder[]>(() => {
    const paths = getQuickRunPaths(this.quickRun().config);
    const folders: QuickRunOpenableFolder[] = [];
    const opCssClass = this.operationDef()?.cssClass || 'primary';

    // Source path(s)
    if (paths.source) {
      const rawSources = Array.isArray(paths.source) ? paths.source : [paths.source];
      for (const src of rawSources) {
        if (src && typeof src === 'string' && src.trim().length > 0) {
          const isLocal = this.pathService.isLocalPath(src);
          const shortName = this.pathService.getFilename(src) || src;
          folders.push({
            type: 'source',
            path: src,
            isLocal,
            icon: isLocal ? 'folder' : 'folder-open',
            cssClass: opCssClass,
            tooltip: `${this.translate.instant('overviews.remoteCard.browse')} ${isLocal ? 'Local' : 'Remote'} (${this.translate.instant('detailShared.pathDisplay.source')}: ${shortName})`,
          });
        }
      }
    }

    // Destination path (mount point or target)
    if (
      paths.destination &&
      typeof paths.destination === 'string' &&
      paths.destination.trim().length > 0
    ) {
      const dst = paths.destination;
      const isLocal = this.pathService.isLocalPath(dst);
      const shortName = this.pathService.getFilename(dst) || dst;
      folders.push({
        type: 'destination',
        path: dst,
        isLocal,
        icon: isLocal ? 'folder' : 'folder-open',
        cssClass: opCssClass,
        tooltip: `${this.translate.instant('overviews.remoteCard.browse')} ${isLocal ? 'Local' : 'Remote'} (${this.translate.instant('detailShared.pathDisplay.destination')}: ${shortName})`,
      });
    }

    return folders;
  });

  // ── Actions ───────────────────────────────────────────────────────────────

  onRowClick(): void {
    this.selectedChange.emit(this.quickRun().id);
  }

  onStart(event: MouseEvent): void {
    event.stopPropagation();
    if (this.isActionInProgress()) return;
    this.startRun.emit(this.quickRun());
  }

  onStop(event: MouseEvent): void {
    event.stopPropagation();
    if (this.isActionInProgress()) return;
    this.stopRun.emit(this.quickRun());
  }

  onEdit(event: MouseEvent): void {
    event.stopPropagation();
    this.editRun.emit(this.quickRun());
  }

  onRemoteNameClick(event: MouseEvent): void {
    event.stopPropagation();
    this.openRemoteDetail.emit(this.quickRun().remoteName);
  }

  onOpenFolderClick(path: string, event: Event): void {
    event.stopPropagation();
    if (this.isFolderOpening()) return;
    this.openInFiles.emit({
      remoteName: this.quickRun().remoteName,
      path,
      operationType: this.quickRun().operationType,
    });
    (event.currentTarget as HTMLElement)?.blur();
  }
}
