import { NgClass, TitleCasePipe } from '@angular/common';
import { Component, computed, input, inject, output } from '@angular/core';
import { TranslateService, TranslateModule } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  AppTab,
  PrimaryActionType,
  QuickActionButton,
  Remote,
  RemoteStatus,
  RemoteOperationState,
  RemoteServeState,
  RemoteCardVariant,
  CardDisplayMode,
} from '@app/types';
import { IconService, isLocalPath, RemoteFacadeService } from '@app/services';
import { ACTION_ANIMATION_CLASS } from '@app/types';

interface OpenInFilesEvent {
  remoteName: string;
  path?: string;
}

interface OperationMeta {
  startIcon: string;
  stopIcon: string;
  startTooltip: string;
  stopTooltip: string;
  cssClass: string;
}

export interface OpenableFolder {
  operation: PrimaryActionType;
  profile: string;
  cssClass: string;
  tooltip: string;
  path: string;
  isLocal: boolean;
  icon: string;
}

const OPERATION_META: Record<PrimaryActionType, OperationMeta> = {
  mount: {
    startIcon: 'mount',
    stopIcon: 'eject',
    startTooltip: 'overviews.remoteCard.actions.mount',
    stopTooltip: 'overviews.remoteCard.actions.unmount',
    cssClass: 'accent',
  },
  sync: {
    startIcon: 'refresh',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startSync',
    stopTooltip: 'overviews.remoteCard.actions.stopSync',
    cssClass: 'primary',
  },
  copy: {
    startIcon: 'copy',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startCopy',
    stopTooltip: 'overviews.remoteCard.actions.stopCopy',
    cssClass: 'yellow',
  },
  move: {
    startIcon: 'move',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startMove',
    stopTooltip: 'overviews.remoteCard.actions.stopMove',
    cssClass: 'orange',
  },
  bisync: {
    startIcon: 'right-left',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startBisync',
    stopTooltip: 'overviews.remoteCard.actions.stopBisync',
    cssClass: 'purple',
  },
  serve: {
    startIcon: 'satellite-dish',
    stopIcon: 'stop',
    startTooltip: 'overviews.remoteCard.actions.startServe',
    stopTooltip: 'overviews.remoteCard.actions.stopServe',
    cssClass: 'accent',
  },
};

const SYNC_TYPES: PrimaryActionType[] = ['sync', 'copy', 'move', 'bisync'];
const BROWSABLE_OPS: PrimaryActionType[] = ['mount', 'sync', 'copy', 'move', 'bisync'];

const MODE_DEFAULTS: Record<AppTab, PrimaryActionType[]> = {
  general: ['mount', 'sync', 'bisync'],
  sync: ['sync', 'bisync', 'copy', 'move'],
  mount: ['mount'],
  serve: ['serve'],
};

@Component({
  selector: 'app-remote-card',
  standalone: true,
  imports: [
    NgClass,
    TitleCasePipe,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    TranslateModule,
  ],
  templateUrl: './remote-card.component.html',
  styleUrl: './remote-card.component.scss',
  host: {
    // Let the card be a proper grid/flex item without a wrapper div
    '[style.display]': '"block"',
    // Mirror edit-mode state onto the host so the panel SCSS and CDK can
    // see it directly on the element (e.g. cursor, opacity, pointer-events).
    '[class.is-editing]': 'isEditingLayout()',
    '[class.is-hidden-layout]': 'isHidden() && isEditingLayout()',
  },
})
export class RemoteCardComponent {
  readonly remoteFacade = inject(RemoteFacadeService);
  private readonly translate = inject(TranslateService);
  readonly iconService = inject(IconService);
  readonly isLocalPath = isLocalPath;
  readonly ACTION_ANIMATION_CLASS = ACTION_ANIMATION_CLASS;

  readonly remote = input.required<Remote>();
  readonly mode = input<AppTab>('general');
  readonly displayMode = input<CardDisplayMode>('compact');
  readonly primaryActionLabel = input('Start');
  readonly activeIcon = input('circle-check');
  readonly primaryActions = input<PrimaryActionType[]>([]);
  readonly maxGeneralButtons = input(3);
  readonly maxSyncButtons = input(4);
  readonly maxMountButtons = input(1);

  // Layout-edit inputs — set by the parent panel
  readonly isEditingLayout = input(false);
  readonly isHidden = input(false);

  readonly remoteClick = output<Remote>();
  readonly openInFiles = output<OpenInFilesEvent>();
  readonly startJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();
  readonly stopJob = output<{
    type: PrimaryActionType;
    remoteName: string;
    profileName?: string;
  }>();
  // Emits the remote name so the panel can call toggleHidden.emit(name)
  readonly toggleHidden = output<string>();

  readonly actionStates = computed(
    () => this.remoteFacade.actionInProgress()[this.remote().name] ?? []
  );

  private readonly actionState = computed(() => this.actionStates()[0]?.type ?? null);

  private readonly anySyncActive = computed(() => SYNC_TYPES.some(op => this.isOpActive(op)));

  readonly cardVariant = computed<RemoteCardVariant>(() => {
    switch (this.mode()) {
      case 'mount':
        return this.isOpActive('mount') ? 'active' : 'inactive';
      case 'sync':
        return this.anySyncActive() ? 'active' : 'inactive';
      case 'serve':
        return this.isOpActive('serve') ? 'active' : 'inactive';
      default:
        return this.isOpActive('mount') || this.anySyncActive() || this.isOpActive('serve')
          ? 'active'
          : 'inactive';
    }
  });

  readonly remoteCardClasses = computed(() => {
    const s = this.remote().status;
    return {
      [`${this.cardVariant()}-remote`]: true,
      mounted: !!s.mount.active,
      syncing: !!s.sync.active,
      copying: !!s.copy.active,
      moving: !!s.move.active,
      bisyncing: !!s.bisync.active,
      serving: !!s.serve.active,
    };
  });

  readonly actionButtons = computed<QuickActionButton[]>(() => {
    switch (this.mode()) {
      case 'general':
        return this.buildButtons(this.primaryActionsFor(this.maxGeneralButtons()));
      case 'mount':
        return this.buildButtons(this.primaryActionsFor(this.maxMountButtons()));
      case 'sync':
        return this.buildButtons(this.primaryActionsFor(this.maxSyncButtons(), false));
      case 'serve': {
        const btn = this.buildOpButton('serve');
        return btn ? [btn] : [];
      }
      default:
        return [];
    }
  });

  readonly detailedOperations = computed<PrimaryActionType[]>(() => {
    const candidates = this.candidatesForDetailedMode();
    return candidates.filter(op => this.getConfiguredProfiles(op).length > 0);
  });

  readonly isFolderOpening = computed<boolean>(() =>
    this.actionStates().some(a => a.type === 'open')
  );

  readonly openableFolders = computed<OpenableFolder[]>(() => {
    const currentMode = this.mode();
    const relevantOps: PrimaryActionType[] =
      currentMode === 'general'
        ? BROWSABLE_OPS
        : currentMode === 'sync'
          ? SYNC_TYPES
          : currentMode === 'mount'
            ? ['mount']
            : [];

    const folders: OpenableFolder[] = [];
    for (const op of relevantOps) {
      if (!this.isOpActive(op)) continue;
      const activeProfiles = this.getActiveProfiles(op);
      if (!activeProfiles) continue;
      for (const profile of Object.keys(activeProfiles)) {
        for (const path of this.getProfileOpenPaths(op, profile)) {
          const local = isLocalPath(path);
          const profileSuffix = profile === 'default' ? '' : ` · ${profile}`;
          folders.push({
            operation: op,
            profile,
            path,
            isLocal: local,
            icon: local ? 'folder' : 'folder-open',
            cssClass: OPERATION_META[op].cssClass,
            tooltip: `${this.translate.instant('overviews.remoteCard.browse')} ${local ? 'Local' : 'Remote'} (${op}${profileSuffix})`,
          });
        }
      }
    }
    return folders;
  });

  readonly folderBlossomStyle = computed(() => {
    const folders = this.openableFolders();
    if (folders.length <= 1) return null;

    const uniqueClasses = [...new Set(folders.map(f => f.cssClass))];
    if (uniqueClasses.length <= 1) return null;

    const classToVar: Record<string, string> = {
      accent: 'var(--accent-color)',
      primary: 'var(--primary-color)',
      yellow: 'var(--yellow)',
      orange: 'var(--orange)',
      purple: 'var(--purple)',
    };

    const colors = uniqueClasses.map(c => classToVar[c] ?? 'var(--primary-color)');
    return {
      color: 'white',
      background: `linear-gradient(135deg, ${colors.join(', ')})`,
    };
  });

  // ── Button builders ────────────────────────────────────────────────────────

  private buildButtons(actions: PrimaryActionType[]): QuickActionButton[] {
    return actions.map(type => this.buildOpButton(type)).filter((b): b is QuickActionButton => !!b);
  }

  private buildOpButton(type: PrimaryActionType, startOnly = false): QuickActionButton | null {
    const meta = OPERATION_META[type];
    if (!meta) return null;

    const actionState = this.actionState();
    const isActive = !startOnly && this.isOpActive(type);
    const inProgress = actionState === type || (!startOnly && actionState === 'stop');
    const isLoading = startOnly
      ? actionState === type
      : type === 'mount' || type === 'serve'
        ? inProgress
        : inProgress && isActive;

    const activeProfile = this.getFirstActiveProfile(type);
    return {
      id: type,
      icon: isActive ? meta.stopIcon : meta.startIcon,
      tooltip: isActive
        ? `${this.translate.instant(meta.stopTooltip)} (${activeProfile})`
        : this.translate.instant(meta.startTooltip),
      isLoading,
      isDisabled: inProgress,
      cssClass: isActive ? 'warn' : meta.cssClass,
    };
  }

  private primaryActionsFor(limit: number, includeMount = true): PrimaryActionType[] {
    const source =
      this.mode() === 'general' && this.primaryActions().length > 0
        ? this.primaryActions()
        : (MODE_DEFAULTS[this.mode()] ?? ['mount', 'bisync']);

    return [...new Set(source)].filter(a => includeMount || a !== 'mount').slice(0, limit);
  }

  private candidatesForDetailedMode(): PrimaryActionType[] {
    switch (this.mode()) {
      case 'general':
        return this.primaryActionsFor(this.maxGeneralButtons());
      case 'mount':
        return ['mount'];
      case 'sync':
        return this.primaryActionsFor(this.maxSyncButtons(), false);
      case 'serve':
        return ['serve'];
      default:
        return [];
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  onRemoteClick(): void {
    this.remoteClick.emit(this.remote());
  }

  onRemoteKeyDown(event: KeyboardEvent): void {
    // Only trigger if the target is the card itself (not a button inside it)
    if (event.target !== event.currentTarget) return;

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.onRemoteClick();
    }
  }

  onToggleHidden(event: Event): void {
    event.stopPropagation();
    this.toggleHidden.emit(this.remote().name);
  }

  onActionButtonClick(action: { id: string; event: Event }): void {
    action.event.stopPropagation();
    const type = action.id as PrimaryActionType;
    if (!OPERATION_META[type]) return;
    const remoteName = this.remote().name;
    if (this.isOpActive(type)) {
      this.stopJob.emit({ type, remoteName, profileName: this.getFirstActiveProfile(type) });
    } else {
      this.startJob.emit({ type, remoteName });
    }
  }

  onProfileOpenInFiles(
    _operationType: PrimaryActionType,
    _profileName: string,
    path: string,
    event: Event
  ): void {
    event.stopPropagation();
    this.openInFiles.emit({ remoteName: this.remote().name, path });
  }

  onOpenFolderClick(folder: OpenableFolder, event: Event): void {
    event.stopPropagation();
    this.openInFiles.emit({ remoteName: this.remote().name, path: folder.path });
    (event.currentTarget as HTMLElement)?.blur();
  }

  onProfileChipClick(operationType: PrimaryActionType, profileName: string, event: Event): void {
    event.stopPropagation();
    if (this.isProfileActionInProgress(operationType, profileName)) return;
    const remoteName = this.remote().name;
    if (this.isProfileActive(operationType, profileName)) {
      this.stopJob.emit({ type: operationType, remoteName, profileName });
    } else {
      this.startJob.emit({ type: operationType, remoteName, profileName });
    }
  }

  // ── Profile chip helpers ───────────────────────────────────────────────────

  isProfileActionInProgress(op: PrimaryActionType, profile: string): boolean {
    return this.actionStates().some(a => {
      if (a.profileName && a.profileName !== profile) return false;
      return a.type === 'stop' ? a.operationType === op : a.type === op;
    });
  }

  getProfileChipTooltip(op: PrimaryActionType, profile: string): string {
    const key = this.isProfileActive(op, profile)
      ? OPERATION_META[op].stopTooltip
      : OPERATION_META[op].startTooltip;
    return `${this.translate.instant(key)} (${profile})`;
  }

  getProfileOpenTooltip(profileName: string, path: string): string {
    return `${this.translate.instant('overviews.remoteCard.browse')} ${isLocalPath(path) ? 'Local' : 'Remote'} (${profileName})`;
  }

  getOperationLabelIcon(op: PrimaryActionType): string {
    return OPERATION_META[op]?.startIcon ?? 'circle';
  }

  getOperationCssClass(op: PrimaryActionType): string {
    return OPERATION_META[op]?.cssClass ?? 'primary';
  }

  // ── Operation state helpers ────────────────────────────────────────────────

  private opStatus(op: PrimaryActionType): RemoteOperationState | RemoteServeState {
    return this.remote().status[op as keyof Omit<RemoteStatus, 'diskUsage'>] as
      | RemoteOperationState
      | RemoteServeState;
  }

  isOpActive(op: PrimaryActionType): boolean {
    return !!this.opStatus(op)?.active;
  }

  private getActiveProfiles(op: PrimaryActionType): Record<string, unknown> | undefined {
    return this.opStatus(op)?.activeProfiles;
  }

  getFirstActiveProfile(op: PrimaryActionType): string {
    const profiles = this.getActiveProfiles(op);
    return profiles ? (Object.keys(profiles)[0] ?? 'default') : 'default';
  }

  getProfileTooltip(op: PrimaryActionType): string {
    const names = Object.keys(this.getActiveProfiles(op) ?? {});
    if (names.length === 0) return op;
    if (names.length === 1) return `${op} (${names[0]})`;
    return `${op} (${names.join(', ')})`;
  }

  // ── Configured profiles helpers (detailed variant) ─────────────────────────

  getConfiguredProfiles(op: PrimaryActionType): string[] {
    return this.opStatus(op)?.configuredProfiles ?? [];
  }

  isProfileActive(op: PrimaryActionType, profile: string): boolean {
    return profile in (this.getActiveProfiles(op) ?? {});
  }

  canOpenProfilePath(op: PrimaryActionType, profile: string): boolean {
    return this.getProfileOpenPaths(op, profile).length > 0;
  }

  getProfileOpenPaths(op: PrimaryActionType, profile: string): string[] {
    if (op === 'serve') return [];

    const paths: string[] = [];

    if (op === 'mount') {
      if (!this.isProfileActive(op, profile)) return paths;
      const active = this.getActiveProfiles('mount')?.[profile];
      if (typeof active === 'string') paths.push(active);
    }

    if (SYNC_TYPES.includes(op) && !this.isProfileActive(op, profile)) return paths;

    const browsePaths = (this.opStatus(op) as RemoteOperationState)?.profileBrowsePaths;
    const configuredPaths = browsePaths?.[profile];

    if (Array.isArray(configuredPaths)) {
      paths.push(...configuredPaths);
    } else if (typeof configuredPaths === 'string') {
      paths.push(configuredPaths);
    }

    const activeProfileValue = this.getActiveProfiles(op)?.[profile];
    if (typeof activeProfileValue === 'string' && !paths.includes(activeProfileValue)) {
      paths.push(activeProfileValue);
    }

    return [...new Set(paths)];
  }
}
