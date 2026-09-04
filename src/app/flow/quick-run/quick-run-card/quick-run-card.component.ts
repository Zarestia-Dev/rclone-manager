import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe } from '@ngx-translate/core';

import {
  getQuickRunPaths,
  OpenInFilesEvent,
  OPERATION_REGISTRY,
  QuickRun,
  isFolderOpeningAction,
} from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';

const OPERATION_MAP = new Map(OPERATION_REGISTRY.map(op => [op.key, op]));

export interface QuickRunOpenableFolder {
  type: 'source' | 'destination';
  path: string;
  shortName: string;
  isLocal: boolean;
  icon: string;
  cssClass: string;
}

/**
 * Dashboard card component for Quick Runs with direct Start/Stop, Edit, and Browse actions.
 */
@Component({
  selector: 'app-quick-run-card',
  imports: [MatButtonModule, MatCardModule, MatIconModule, CdkMenuModule, TranslatePipe],
  templateUrl: './quick-run-card.component.html',
  styleUrls: ['./quick-run-card.component.scss', '../../../styles/_shared-card.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.is-running]': 'isRunning()',
    '[class.selected]': 'selected()',
    '[class]': 'cardOperationClass()',
    '(click)': 'onRowClick()',
  },
})
export class QuickRunCardComponent {
  readonly pathService = inject(PathService);
  readonly iconService = inject(IconService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly quickRunService = inject(QuickRunService);

  /** The quick run this card represents. */
  readonly quickRun = input.required<QuickRun>();
  /** True if this card is currently selected (drives highlight). */
  readonly selected = input<boolean>(false);
  /** True if the quick run is currently running (drives status dot/badge). */
  readonly isRunning = input<boolean>(false);

  /** Emitted when the card is clicked (selects quick run for detail view). */
  readonly selectedChange = output<string>();
  /** Emitted when the Start action button is clicked. */
  readonly startRun = output<QuickRun>();
  /** Emitted when the Stop action button is clicked. */
  readonly stopRun = output<QuickRun>();
  /** Emitted when the Edit action button is clicked. */
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

  readonly operationDef = computed(() => OPERATION_MAP.get(this.quickRun().operationType));

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

  /** App configuration indicators (Cron schedule, File Watcher, AutoStart). */
  readonly appConfig = computed(() => this.quickRun().config?.app);

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
          folders.push({
            type: 'source',
            path: src,
            shortName: this.pathService.getFilename(src) || src,
            isLocal,
            icon: isLocal ? 'folder' : 'folder-open',
            cssClass: opCssClass,
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
      folders.push({
        type: 'destination',
        path: dst,
        shortName: this.pathService.getFilename(dst) || dst,
        isLocal,
        icon: isLocal ? 'folder' : 'folder-open',
        cssClass: opCssClass,
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
