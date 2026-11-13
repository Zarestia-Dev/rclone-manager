import * as pathUtils from 'src/app/shared/utils/path.utils';
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

import {
  BrowseTarget,
  getOperationDef,
  getQuickRunPaths,
  isFolderOpeningAction,
  NO_ACTIONS,
  OpenInFilesEvent,
  PillTone,
  QuickRun,
  QuickRunConfig,
} from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { IconService } from 'src/app/services/ui/icon.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { QuickRunService } from 'src/app/services/flow/quick-run.service';

import { FolderBrowseButtonComponent } from '../../../shared/components/folder-browse-button/folder-browse-button.component';
import { PillDirective } from '../../../shared/directives/pill.directive';

/**
 * Dashboard card component for Quick Runs with direct Start/Stop, Edit, and Browse actions.
 */
@Component({
  selector: 'app-quick-run-card',
  imports: [
    MatButtonModule,
    MatIconModule,
    TranslatePipe,
    PillDirective,
    FolderBrowseButtonComponent,
  ],
  templateUrl: './quick-run-card.component.html',
  styleUrls: ['./quick-run-card.component.scss', '../../../styles/_shared-card.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.is-active]': 'isRunning()',
    '[attr.data-tone]': 'cardTone()',
    '(click)': 'onRowClick()',
  },
})
export class QuickRunCardComponent {
  private readonly pathService = inject(PathService);
  private readonly iconService = inject(IconService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly quickRunService = inject(QuickRunService);

  /** The quick run this card represents. */
  readonly quickRun = input.required<QuickRun>();

  /** Emitted when the card is clicked (selects the quick run for the detail view). */
  readonly selectRun = output<string>();
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

  // ── Reactive state ────────────────────────────────────────────────────────

  readonly isRunning = computed(() => this.quickRunService.runningIds().has(this.quickRun().id));
  readonly isActionInProgress = computed(
    () => !!this.quickRunService.actionInProgress()[this.quickRun().id]
  );
  private readonly actionStates = computed(
    () => this.remoteFacade.actionInProgress()[this.quickRun().remoteName] ?? NO_ACTIONS
  );

  // ── Derived view model ────────────────────────────────────────────────────

  private readonly operationDef = computed(() => getOperationDef(this.quickRun().operationType));

  readonly isRemoteMissing = computed(() =>
    this.remoteFacade.isRemoteMissing(this.quickRun().remoteName)
  );

  readonly remoteIcon = computed(() => {
    const remote = this.remoteFacade.getRemoteSummary(this.quickRun().remoteName);
    return remote ? this.iconService.getIconName(remote.type) : 'cloud';
  });

  readonly icon = computed(() => this.operationDef()?.icon ?? 'operations');
  readonly animationClass = computed(() =>
    this.isRunning() ? (this.operationDef()?.animationClass ?? 'animate-spin') : ''
  );
  readonly actionLabel = computed(() => this.operationDef()?.actionLabel ?? 'Start');
  readonly cardTone = computed<PillTone>(() => this.operationDef()?.tone ?? 'primary');

  readonly currentActionIcon = computed(() => {
    const def = this.operationDef();
    return this.isRunning() ? (def?.stopIcon ?? 'stop') : (def?.startIcon ?? this.icon());
  });

  /** Tooltip of the start/stop button: why it is unavailable, or what it will do. */
  readonly primaryTitle = computed(() => {
    if (this.isRemoteMissing()) {
      return {
        key: 'flow.quickRun.errors.remoteNotFound',
        params: { remote: this.quickRun().remoteName },
      };
    }
    const def = this.operationDef();
    return {
      key: this.isRunning()
        ? (def?.stopTooltip ?? 'flow.quickRun.actions.stop')
        : (def?.startTooltip ?? 'flow.quickRun.actions.start'),
      params: undefined,
    };
  });

  /** Schedule, watcher and autostart indicators. `app` is optional in stored data. */
  readonly appConfig = computed<Partial<QuickRunConfig['app']>>(
    () => this.quickRun().config?.app ?? {}
  );

  /** Every folder this quick run reads from or writes to, for the browse button. */
  readonly browseTargets = computed<BrowseTarget[]>(() => {
    const { source, destination } = getQuickRunPaths(this.quickRun().config);
    const tone = this.cardTone();
    const isOpening = isFolderOpeningAction(this.actionStates());
    const entries = [
      ...[source ?? []].flat().map(path => ({ kind: 'source', path })),
      ...(destination ? [{ kind: 'destination', path: destination }] : []),
    ];

    return entries
      .filter(({ path }) => path.trim().length > 0)
      .map(({ kind, path }) => ({
        key: `${kind}:${path}`,
        path,
        icon: this.pathService.isLocalPath(path) ? 'folder' : 'folder-open',
        tone,
        labelKey: `detailShared.pathDisplay.${kind}`,
        detail: pathUtils.getFilename(path) || path,
        isOpening,
      }));
  });

  // ── Actions ───────────────────────────────────────────────────────────────

  onRowClick(): void {
    this.selectRun.emit(this.quickRun().id);
  }

  onToggleRun(event: Event): void {
    event.stopPropagation();
    if (this.isActionInProgress()) return;
    if (this.isRunning()) this.stopRun.emit(this.quickRun());
    else this.startRun.emit(this.quickRun());
  }

  onEdit(event: Event): void {
    event.stopPropagation();
    this.editRun.emit(this.quickRun());
  }

  onRemoteNameClick(event: Event): void {
    event.stopPropagation();
    this.openRemoteDetail.emit(this.quickRun().remoteName);
  }

  onOpenFolder(target: BrowseTarget): void {
    const { remoteName, operationType } = this.quickRun();
    this.openInFiles.emit({ remoteName, path: target.path, operationType });
  }
}
