import { NgClass, TitleCasePipe } from '@angular/common';
import { Component, computed, input, inject, output, ChangeDetectionStrategy } from '@angular/core';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
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

interface StatusIndicatorViewModel {
  op: PrimaryActionType;
  meta: { icon: string; pillClass: string; ariaKey: string; animateContainer?: boolean };
  tooltip: string;
}

interface ProfilePathViewModel {
  path: string;
  isLocal: boolean;
  tooltip: string;
}

interface ProfileChipViewModel {
  name: string;
  isBusy: boolean;
  canOpen: boolean;
  isActive: boolean;
  chipTooltip: string;
  openPaths: ProfilePathViewModel[];
}

interface DetailedOperationViewModel {
  operation: PrimaryActionType;
  cssClass: string;
  labelIcon: string;
  profiles: ProfileChipViewModel[];
}

/** Per-operation profile picker entry used by the compact card's hover blossom. */
interface ProfilePickerEntry {
  operation: PrimaryActionType;
  profile: string;
  isActive: boolean;
  isBusy: boolean;
  startIcon: string;
  stopIcon: string;
  cssClass: string;
  tooltip: string;
}

/** Per-operation group of profile picker entries (one group per operation). */
interface ProfilePickerGroup {
  operation: PrimaryActionType;
  cssClass: string;
  /** Single-button trigger tooltip when only one profile exists. */
  triggerTooltip: string;
  /** Icon to show on the trigger button. */
  triggerIcon: string;
  /** Whether the operation is currently active (any profile running). */
  isActive: boolean;
  /** Whether at least one in-flight action targets this operation. */
  isBusy: boolean;
  entries: ProfilePickerEntry[];
}

@Component({
  selector: 'app-remote-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgClass,
    TitleCasePipe,
    MatIconModule,
    MatButtonModule,
    MatMenuModule,
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

  isFolderOpeningFor(op: PrimaryActionType, profile: string): boolean {
    return this.actionStates().some(
      a => a.type === 'open' && a.operationType === op && a.profileName === profile
    );
  }

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
          // Show the profile name in the tooltip regardless — all profiles
          // are equal now, none is hidden behind a 'default' suppression.
          const profileSuffix = ` · ${profile}`;
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

  readonly statusIndicatorViewModels = computed<StatusIndicatorViewModel[]>(() =>
    this.visibleStatusIndicators().map(op => ({
      op,
      meta: this.getStatusIndicatorMeta(op),
      tooltip: this.getProfileTooltip(op),
    }))
  );

  /**
   * Per-operation profile-picker groups for compact mode.
   *
   * For each action button that has multiple configured profiles, this produces
   * a group with one entry per profile. The template uses this to render a
   * `.folder-blossom`-style hover popup on the action button so the user can
   * pick which profile to act on — there is no longer any "default profile"
   * auto-pick.
   *
   * Operations with exactly one configured profile produce a single-entry group
   * — the template renders those as a plain action button (no blossom).
   */
  readonly profilePickerGroups = computed<ProfilePickerGroup[]>(() => {
    if (this.displayMode() !== 'compact') return [];
    const buttons = this.actionButtons();
    const groups: ProfilePickerGroup[] = [];
    for (const btn of buttons) {
      const op = btn.id as PrimaryActionType;
      const configured = this.getConfiguredProfiles(op);
      if (configured.length === 0) continue;
      const meta = OPERATION_META[op];
      const isActive = this.isOpActive(op);
      // isBusy for the group trigger: true if ANY profile of this op is in progress.
      const isBusy = this.actionStates().some(
        a =>
          a.type === op ||
          (op === 'mount' && a.type === 'unmount') ||
          (a.type === 'stop' && a.operationType === op)
      );
      const entries: ProfilePickerEntry[] = configured.map(profile => ({
        operation: op,
        profile,
        isActive: this.isProfileActive(op, profile),
        isBusy: this.isProfileActionInProgress(op, profile),
        startIcon: meta?.startIcon ?? 'play',
        stopIcon: op === 'mount' ? 'eject' : 'stop',
        cssClass: meta?.cssClass ?? 'primary',
        tooltip: this.getProfileChipTooltip(op, profile),
      }));
      groups.push({
        operation: op,
        cssClass: meta?.cssClass ?? 'primary',
        triggerTooltip: btn.tooltip,
        triggerIcon: btn.icon,
        isActive,
        isBusy,
        entries,
      });
    }
    return groups;
  });

  readonly profilePickerGroupByOp = computed<Record<string, ProfilePickerGroup>>(() => {
    const map: Record<string, ProfilePickerGroup> = {};
    for (const g of this.profilePickerGroups()) map[g.operation] = g;
    return map;
  });

  readonly detailedOperationViewModels = computed<DetailedOperationViewModel[]>(() =>
    this.detailedOperations().map(operation => ({
      operation,
      cssClass: this.getOperationCssClass(operation),
      labelIcon: this.getOperationLabelIcon(operation),
      profiles: this.getConfiguredProfiles(operation).map<ProfileChipViewModel>(profile => ({
        name: profile,
        isBusy: this.isProfileActionInProgress(operation, profile),
        canOpen: this.canOpenProfilePath(operation, profile),
        isActive: this.isProfileActive(operation, profile),
        chipTooltip: this.getProfileChipTooltip(operation, profile),
        openPaths: this.getProfileOpenPaths(operation, profile).map<ProfilePathViewModel>(path => ({
          path,
          isLocal: this.pathService.isLocalPath(path),
          tooltip: this.getProfileOpenTooltip(profile, path),
        })),
      })),
    }))
  );

  // ── Button builders ────────────────────────────────────────────────────────

  private buildButtons(actions: PrimaryActionType[]): QuickActionButton[] {
    return actions.map(type => this.buildOpButton(type)).filter((b): b is QuickActionButton => !!b);
  }

  private buildOpButton(type: PrimaryActionType, startOnly = false): QuickActionButton | null {
    const meta = OPERATION_META[type];
    if (!meta) return null;

    // Compute inProgress for this specific operation type only (not global first-action).
    const inProgress = this.actionStates().some(
      a =>
        a.type === type ||
        (type === 'mount' && a.type === 'unmount') ||
        (a.type === 'stop' && a.operationType === type)
    );
    const isActive = !startOnly && this.isOpActive(type);
    const isLoading = startOnly
      ? this.actionStates().some(a => a.type === type)
      : type === 'mount' || type === 'serve'
        ? inProgress
        : inProgress && isActive;

    const configuredCount = this.getConfiguredProfiles(type).length;
    const hasNoProfiles = configuredCount === 0;

    const activeProfile = this.getFirstActiveProfile(type);
    return {
      id: type,
      icon: isActive ? meta.stopIcon : meta.startIcon,
      tooltip: isActive
        ? `${this.translate.instant(meta.stopTooltip)} (${activeProfile})`
        : this.translate.instant(meta.startTooltip),
      isLoading,
      isDisabled: inProgress || hasNoProfiles,
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

    // Stop case: if the operation is active, stop the first active profile.
    // (For multi-profile stops, the user should click the per-profile blossom
    // or the detailed-mode pill — those go through onProfilePickerClick.)
    if (this.isOpActive(type)) {
      const profileName = this.getFirstActiveProfile(type);
      if (profileName) {
        this.stopJob.emit({ type, remoteName, profileName });
      }
      return;
    }

    // Start case: if exactly one profile is configured, start it directly.
    // If zero or multiple profiles are configured, do nothing here — the
    // multi-profile case is handled by the hover blossom; the zero-profile
    // case is a no-op (the action button should be disabled in that case).
    const configured = this.getConfiguredProfiles(type);
    if (configured.length === 1) {
      this.startJob.emit({ type, remoteName, profileName: configured[0] });
    }
  }

  /**
   * Per-profile action click from the compact-mode hover blossom.
   * Starts or stops the specific profile the user clicked.
   */
  onProfilePickerClick(operation: PrimaryActionType, profile: string, event: Event): void {
    event.stopPropagation();
    const remoteName = this.remote().name;
    if (this.isProfileActive(operation, profile)) {
      this.stopJob.emit({ type: operation, remoteName, profileName: profile });
    } else {
      this.startJob.emit({ type: operation, remoteName, profileName: profile });
    }
    (event.currentTarget as HTMLElement)?.blur();
  }

  onProfileOpenInFiles(
    operationType: PrimaryActionType,
    profileName: string,
    path: string,
    event: Event
  ): void {
    event.stopPropagation();
    this.openInFiles.emit({
      remoteName: this.remote().name,
      path,
      profileName,
      operationType,
    });
  }

  onOpenFolderClick(folder: OpenableFolder, event: Event): void {
    event.stopPropagation();
    this.openInFiles.emit({
      remoteName: this.remote().name,
      path: folder.path,
      profileName: folder.profile,
      operationType: folder.operation,
    });
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
      // If a profileName is stored, it must match exactly.
      if (a.profileName && a.profileName !== profile) return false;
      // If no profileName is stored, only match if there is only one configured profile.
      if (!a.profileName && this.getConfiguredProfiles(op).length > 1) return false;
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
      RemoteOperationState | RemoteServeState;
  }

  isOpActive(op: PrimaryActionType): boolean {
    return !!this.opStatus(op)?.active;
  }

  private getActiveProfiles(op: PrimaryActionType): Record<string, unknown> | undefined {
    return this.opStatus(op)?.activeProfiles;
  }

  getFirstActiveProfile(op: PrimaryActionType): string {
    const profiles = this.getActiveProfiles(op);
    return profiles ? (Object.keys(profiles)[0] ?? '') : '';
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
