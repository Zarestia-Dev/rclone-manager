import * as pathUtils from 'src/app/shared/utils/path.utils';
import { TitleCasePipe } from '@angular/common';
import { Component, computed, input, inject, output, ChangeDetectionStrategy } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MatIconModule } from '@angular/material/icon';
import {
  AppTab,
  PrimaryActionType,
  QuickActionButton,
  Remote,
  RemoteStatus,
  RemoteOperationState,
  RemoteServeState,
  CardDisplayMode,
  StartJobEvent,
  StopJobEvent,
  OPERATION_META,
  PillTone,
  OPERATION_TONE,
  SYNC_TYPES,
  BROWSABLE_OPS,
  ALL_PRIMARY_ACTIONS,
  MODE_DEFAULTS,
  NO_ACTIONS,
  operationsOfTab,
  OpenInFilesEvent,
  OpenableFolder,
  ACTION_ANIMATION_CLASS,
  isOperationActionInProgress,
  isFolderOpeningAction,
} from '@app/types';
import { IconService } from 'src/app/services/ui/icon.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import {
  StatusIndicatorViewModel,
  ProfilePathViewModel,
  ProfileChipViewModel,
  DetailedOperationViewModel,
  ProfilePickerEntry,
  ProfilePickerGroup,
  ProfilePathTarget,
  ProfileTarget,
  STATUS_INDICATOR_META,
} from './remote-card.types';
import { RemoteCardActionsComponent } from './remote-card-actions.component';
import { RemoteCardProfileDetailsComponent } from './remote-card-profile-details.component';

import { PillDirective } from '../../directives/pill.directive';
@Component({
  selector: 'app-remote-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TitleCasePipe,
    MatIconModule,
    TranslatePipe,
    RemoteCardActionsComponent,
    RemoteCardProfileDetailsComponent,
    PillDirective,
  ],
  templateUrl: './remote-card.component.html',
  styleUrls: ['./remote-card.component.scss', '../../../styles/_shared-card.scss'],
  host: {
    role: 'button',
    '[attr.tabindex]': 'isEditingLayout() ? -1 : 0',
    '(click)': 'onRemoteClick()',
    '(keydown)': 'onRemoteKeyDown($event)',
    '[class.is-editing]': 'isEditingLayout()',
    '[class.is-hidden-layout]': 'isHidden() && isEditingLayout()',
    '[class.is-active]': 'isActive()',
    '[attr.data-tone]': 'cardTone()',
  },
})
export class RemoteCardComponent {
  private readonly remoteFacade = inject(RemoteFacadeService);
  readonly iconService = inject(IconService);
  readonly pathService = inject(PathService);
  readonly ACTION_ANIMATION_CLASS = ACTION_ANIMATION_CLASS;

  readonly remote = input.required<Remote>();
  readonly mode = input<AppTab>('general');
  readonly displayMode = input<CardDisplayMode>('compact');
  readonly primaryActions = input<PrimaryActionType[]>([]);
  readonly syncActions = input<PrimaryActionType[]>([]);
  readonly maxGeneralButtons = input(3);
  readonly maxSyncButtons = input(3);

  // Layout-edit inputs — set by the parent panel
  readonly isEditingLayout = input(false);
  readonly isHidden = input(false);

  readonly remoteClick = output<Remote>();
  readonly openInFiles = output<OpenInFilesEvent>();
  readonly startJob = output<StartJobEvent>();
  readonly stopJob = output<StopJobEvent>();
  readonly toggleHidden = output<string>();

  private readonly actionStates = computed(
    () => this.remoteFacade.actionInProgress()[this.remote().name] ?? NO_ACTIONS
  );

  private readonly activeTabOperations = computed(() =>
    operationsOfTab(this.mode()).filter(op => this.isOpActive(op))
  );

  /** Whether anything this tab shows is running; drives the card ring and icon. */
  readonly isActive = computed(() => this.activeTabOperations().length > 0);

  /** The colour of the last running operation of this tab (registry order); primary while idle. */
  readonly cardTone = computed<PillTone>(() => {
    const op = this.activeTabOperations().at(-1);
    return op ? OPERATION_TONE[op] : 'primary';
  });

  readonly actionButtons = computed<QuickActionButton[]>(() => {
    switch (this.mode()) {
      case 'general':
        return this.buildButtons(this.primaryActionsFor(this.maxGeneralButtons()));
      case 'mount':
        return this.buildButtons(['mount']);
      case 'operations':
        return this.buildButtons(this.primaryActionsFor(this.maxSyncButtons(), false));
      case 'serve':
        return this.buildButtons(['serve']);
      default:
        return [];
    }
  });

  readonly statusIndicatorViewModels = computed<StatusIndicatorViewModel[]>(() => {
    const shown = new Set(this.actionButtons().map(btn => btn.id));
    return ALL_PRIMARY_ACTIONS.filter(op => this.isOpActive(op) && !shown.has(op)).map(op => ({
      op,
      meta: STATUS_INDICATOR_META[op],
      profiles: Object.keys(this.getActiveProfiles(op) ?? {}).join(', '),
    }));
  });

  readonly detailedOperations = computed<PrimaryActionType[]>(() =>
    this.candidatesForDetailedMode().filter(op => this.getConfiguredProfiles(op).length > 0)
  );

  readonly detailedOperationViewModels = computed<DetailedOperationViewModel[]>(() =>
    this.detailedOperations().map(operation => ({
      operation,
      tone: OPERATION_META[operation].tone,
      labelIcon: OPERATION_META[operation].startIcon,
      profiles: this.getConfiguredProfiles(operation).map<ProfileChipViewModel>(profile => {
        const isActive = this.isProfileActive(operation, profile);
        const openPaths = this.getProfileOpenPaths(operation, profile);
        return {
          name: profile,
          isBusy: this.isProfileActionInProgress(operation, profile),
          isActive,
          isOpening: isFolderOpeningAction(this.actionStates(), operation, profile),
          tooltipKey: this.tooltipKey(operation, isActive),
          openPaths: openPaths.map<ProfilePathViewModel>(path => ({
            path,
            icon: this.pathService.isLocalPath(path) ? 'folder' : 'folder-open',
          })),
        };
      }),
    }))
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
      for (const profile of Object.keys(this.getActiveProfiles(op) ?? {})) {
        const isOpening = isFolderOpeningAction(this.actionStates(), op, profile);
        for (const path of this.getProfileOpenPaths(op, profile)) {
          folders.push({
            key: `${op}:${profile}:${path}`,
            operation: op,
            profile,
            path,
            label: profile,
            detail: pathUtils.getFilename(path) || '/',
            isOpening,
            icon: this.pathService.isLocalPath(path) ? 'folder' : 'folder-open',
            tone: OPERATION_META[op].tone,
          });
        }
      }
    }
    return folders;
  });

  /** One picker per operation that has several profiles to choose from (compact cards only). */
  readonly profilePickers = computed<Record<string, ProfilePickerGroup>>(() => {
    const pickers: Record<string, ProfilePickerGroup> = {};
    if (this.displayMode() !== 'compact') return pickers;
    for (const btn of this.actionButtons()) {
      const op = btn.id as PrimaryActionType;
      const configured = this.getConfiguredProfiles(op);
      if (configured.length < 2) continue;
      const meta = OPERATION_META[op];
      pickers[op] = {
        operation: op,
        tone: meta.tone,
        triggerTooltipKey: this.tooltipKey(op, this.isOpActive(op)),
        triggerIcon: btn.icon,
        isActive: this.isOpActive(op),
        isBusy: isOperationActionInProgress(this.actionStates(), op),
        entries: configured.map<ProfilePickerEntry>(profile => ({
          operation: op,
          profile,
          isActive: this.isProfileActive(op, profile),
          isBusy: this.isProfileActionInProgress(op, profile),
          startIcon: meta.startIcon,
          stopIcon: op === 'mount' ? 'eject' : 'stop',
          tone: meta.tone,
        })),
      };
    }
    return pickers;
  });

  // ── Button builders ────────────────────────────────────────────────────────

  private buildButtons(actions: PrimaryActionType[]): QuickActionButton[] {
    return actions.map(type => this.buildOpButton(type));
  }

  private buildOpButton(type: PrimaryActionType): QuickActionButton {
    const meta = OPERATION_META[type];
    const inProgress = isOperationActionInProgress(this.actionStates(), type);
    const isActive = this.isOpActive(type);
    return {
      id: type,
      icon: isActive ? meta.stopIcon : meta.startIcon,
      tooltipKey: this.tooltipKey(type, isActive),
      tooltipProfile: isActive ? this.getFirstActiveProfile(type) : undefined,
      isLoading: inProgress,
      isDisabled: inProgress || this.getConfiguredProfiles(type).length === 0,
      tone: isActive ? 'warn' : meta.tone,
    };
  }

  private tooltipKey(op: PrimaryActionType, active: boolean): string {
    return active ? OPERATION_META[op].stopTooltip : OPERATION_META[op].startTooltip;
  }

  private primaryActionsFor(limit: number, includeMount = true): PrimaryActionType[] {
    const isOps = this.mode() === 'operations';
    const actionsSource = isOps ? this.syncActions() : this.primaryActions();
    let source = actionsSource.length > 0 ? actionsSource : MODE_DEFAULTS[this.mode()];

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

  /** The card button of an operation: stops it when running, starts its only profile otherwise. */
  onActionButtonClick(type: PrimaryActionType): void {
    if (this.isOpActive(type)) {
      const profileName = this.getFirstActiveProfile(type);
      if (profileName) this.stopJob.emit({ type, remoteName: this.remote().name, profileName });
      return;
    }

    const configured = this.getConfiguredProfiles(type);
    if (configured.length === 1) this.onProfileToggle({ operation: type, profile: configured[0] });
  }

  /** Starts a profile that is idle, stops one that is running. */
  onProfileToggle({ operation, profile }: ProfileTarget): void {
    const event = { type: operation, remoteName: this.remote().name, profileName: profile };
    if (this.isProfileActive(operation, profile)) this.stopJob.emit(event);
    else this.startJob.emit(event);
  }

  onProfileOpenInFiles({ operation, profile, path }: ProfilePathTarget): void {
    this.openInFiles.emit({
      remoteName: this.remote().name,
      path,
      profileName: profile,
      operationType: operation,
    });
  }

  onOpenFolder(folder: OpenableFolder): void {
    this.onProfileOpenInFiles({
      operation: folder.operation,
      profile: folder.profile,
      path: folder.path,
    });
  }

  // ── Operation state helpers ────────────────────────────────────────────────

  private isProfileActionInProgress(op: PrimaryActionType, profile: string): boolean {
    const configured = this.getConfiguredProfiles(op);
    return isOperationActionInProgress(
      this.actionStates(),
      op,
      configured.length > 1 ? profile : undefined
    );
  }

  private opStatus(op: PrimaryActionType): RemoteOperationState | RemoteServeState {
    return this.remote().status[op as keyof Omit<RemoteStatus, 'diskUsage'>] as
      RemoteOperationState | RemoteServeState;
  }

  private isOpActive(op: PrimaryActionType): boolean {
    return !!this.opStatus(op)?.active;
  }

  private getActiveProfiles(op: PrimaryActionType): Record<string, unknown> | undefined {
    return this.opStatus(op)?.activeProfiles;
  }

  private getFirstActiveProfile(op: PrimaryActionType): string {
    const profiles = this.getActiveProfiles(op);
    return profiles ? (Object.keys(profiles)[0] ?? '') : '';
  }

  private getConfiguredProfiles(op: PrimaryActionType): string[] {
    return this.opStatus(op)?.configuredProfiles ?? [];
  }

  private isProfileActive(op: PrimaryActionType, profile: string): boolean {
    return profile in (this.getActiveProfiles(op) ?? {});
  }

  private getProfileOpenPaths(op: PrimaryActionType, profile: string): string[] {
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
