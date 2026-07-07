import { NgClass, TitleCasePipe } from '@angular/common';
import { Component, computed, input, inject, output, ChangeDetectionStrategy } from '@angular/core';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
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
  StartJobEvent,
  StopJobEvent,
  OPERATION_META,
  SYNC_TYPES,
  BROWSABLE_OPS,
  ALL_PRIMARY_ACTIONS,
  MODE_DEFAULTS,
  OpenInFilesEvent,
  OpenableFolder,
  ACTION_ANIMATION_CLASS,
} from '@app/types';
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';

@Component({
  selector: 'app-remote-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgClass,
    TitleCasePipe,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    TranslatePipe,
  ],
  templateUrl: './remote-card.component.html',
  styleUrl: './remote-card.component.scss',
  host: {
    role: 'button',
    '[attr.tabindex]': 'isEditingLayout() ? -1 : 0',
    '(click)': 'onRemoteClick()',
    '(keydown)': 'onRemoteKeyDown($event)',
    '[class.is-editing]': 'isEditingLayout()',
    '[class.is-hidden-layout]': 'isHidden() && isEditingLayout()',
    '[class]': 'remoteCardClasses()',
  },
})
export class RemoteCardComponent {
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly translate = inject(TranslateService);
  readonly iconService = inject(IconService);
  readonly pathService = inject(PathService);
  readonly ACTION_ANIMATION_CLASS = ACTION_ANIMATION_CLASS;

  readonly remote = input.required<Remote>();
  readonly mode = input<AppTab>('general');
  readonly displayMode = input<CardDisplayMode>('compact');
  readonly primaryActionLabel = input('Start');
  readonly activeIcon = input('circle-check');
  readonly primaryActions = input<PrimaryActionType[]>([]);
  readonly syncActions = input<PrimaryActionType[]>([]);
  readonly maxGeneralButtons = input(3);
  readonly maxSyncButtons = input(3);
  readonly maxMountButtons = input(1);

  // Layout-edit inputs — set by the parent panel
  readonly isEditingLayout = input(false);
  readonly isHidden = input(false);

  readonly remoteClick = output<Remote>();
  readonly openInFiles = output<OpenInFilesEvent>();
  readonly startJob = output<StartJobEvent>();
  readonly stopJob = output<StopJobEvent>();
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
      case 'operations':
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
      'remote-card': true,
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
        return this.buildButtons(['mount']);
      case 'operations':
        return this.buildButtons(this.primaryActionsFor(this.maxSyncButtons(), false));
      case 'serve': {
        const btn = this.buildOpButton('serve');
        return btn ? [btn] : [];
      }
      default:
        return [];
    }
  });

  readonly visibleStatusIndicators = computed<PrimaryActionType[]>(() => {
    const activeOps = ALL_PRIMARY_ACTIONS.filter(op => this.isOpActive(op));
    const displayedActionButtonIds = this.actionButtons().map(btn => btn.id as PrimaryActionType);
    return activeOps.filter(op => !displayedActionButtonIds.includes(op));
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
        : currentMode === 'operations'
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
          const local = this.pathService.isLocalPath(path);
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
    const isOps = this.mode() === 'operations';
    const actionsSource = isOps ? this.syncActions() : this.primaryActions();
    const hasActions = actionsSource && actionsSource.length > 0;
    let source = hasActions ? actionsSource : (MODE_DEFAULTS[this.mode()] as PrimaryActionType[]);

    if (isOps) {
      source = source.filter(a => (SYNC_TYPES as PrimaryActionType[]).includes(a));
    }

    return [...new Set(source)].filter(a => includeMount || a !== 'mount').slice(0, limit);
  }

  private candidatesForDetailedMode(): PrimaryActionType[] {
    switch (this.mode()) {
      case 'general':
        return this.primaryActionsFor(this.maxGeneralButtons());
      case 'mount':
        return ['mount'];
      case 'operations':
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
    return `${this.translate.instant('overviews.remoteCard.browse')} ${this.pathService.isLocalPath(path) ? 'Local' : 'Remote'} (${profileName})`;
  }

  getOperationLabelIcon(op: PrimaryActionType): string {
    return OPERATION_META[op]?.startIcon ?? 'circle';
  }

  getOperationCssClass(op: PrimaryActionType): string {
    return OPERATION_META[op]?.cssClass ?? 'primary';
  }

  private static readonly STATUS_INDICATOR_META: Record<
    PrimaryActionType,
    { icon: string; pillClass: string; ariaKey: string; animateContainer?: boolean }
  > = {
    mount: { icon: 'mount', pillClass: 'p-accent', ariaKey: 'detailShared.status.mounted' },
    sync: { icon: 'refresh', pillClass: 'p-primary', ariaKey: 'detailShared.status.syncing' },
    copy: { icon: 'copy', pillClass: 'p-yellow', ariaKey: 'detailShared.status.copying' },
    move: { icon: 'move', pillClass: 'p-orange', ariaKey: 'detailShared.status.moving' },
    bisync: { icon: 'right-left', pillClass: 'p-purple', ariaKey: 'detailShared.status.bisyncing' },
    serve: {
      icon: 'satellite-dish',
      pillClass: 'p-accent',
      ariaKey: 'detailShared.status.serving',
      animateContainer: true,
    },
    check: { icon: 'search', pillClass: 'p-accent', ariaKey: 'operations.checkActive' },
    cryptcheck: { icon: 'shield', pillClass: 'p-accent', ariaKey: 'operations.cryptcheckActive' },
    delete: { icon: 'trash', pillClass: 'p-warn', ariaKey: 'operations.deleteActive' },
    copyurl: { icon: 'link', pillClass: 'p-accent', ariaKey: 'operations.copyurlActive' },
    archivecreate: {
      icon: 'compress',
      pillClass: 'p-primary',
      ariaKey: 'operations.archivecreateActive',
    },
  };

  getStatusIndicatorMeta(op: PrimaryActionType): {
    icon: string;
    pillClass: string;
    ariaKey: string;
    animateContainer?: boolean;
  } {
    return RemoteCardComponent.STATUS_INDICATOR_META[op];
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

    if ((SYNC_TYPES as PrimaryActionType[]).includes(op) && !this.isProfileActive(op, profile))
      return paths;

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
