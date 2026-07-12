import {
  Component,
  inject,
  signal,
  computed,
  output,
  effect,
  untracked,
  DestroyRef,
  ChangeDetectionStrategy,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TitleCasePipe } from '@angular/common';
import {
  DiskUsage,
  JobsPanelConfig,
  PrimaryActionType,
  SettingsPanelConfig,
  StopJobEvent,
  StartJobEvent,
  RemoteStatus,
  ActionViewModel,
  ACTION_CONFIGS,
  STANDARD_MODAL_SIZE,
  MODE_DEFAULTS,
  OPERATION_META,
} from '@app/types';
import { DiskUsagePanelComponent } from '../../../../shared/detail-shared/disk-usage-panel/disk-usage-panel.component';
import { JobsPanelComponent } from '../../../../shared/detail-shared/jobs-panel/jobs-panel.component';
import { SettingsPanelComponent } from '../../../../shared/detail-shared/settings-panel/settings-panel.component';
import { AutomationCardComponent } from '../../../../shared/detail-shared/automation-card/automation-card.component';
import { IconService } from 'src/app/services/ui/icon.service';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { MatDialog } from '@angular/material/dialog';
import { ActionSelectionModalComponent } from 'src/app/features/modals/action-selection-modal/action-selection-modal.component';

@Component({
  selector: 'app-general-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TitleCasePipe,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    SettingsPanelComponent,
    DiskUsagePanelComponent,
    JobsPanelComponent,
    TranslatePipe,
    AutomationCardComponent,
  ],
  templateUrl: './general-detail.component.html',
  styleUrl: './general-detail.component.scss',
})
export class GeneralDetailComponent {
  protected readonly iconService = inject(IconService);
  private readonly automationService = inject(AutomationService);
  private readonly translate = inject(TranslateService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly pathService = inject(PathService);
  private readonly dialog = inject(MatDialog);
  private readonly destroyRef = inject(DestroyRef);

  // State
  protected readonly selectedRemote = computed(() => {
    const remote = this.remoteFacade.selectedRemote();
    if (!remote) throw new Error('[GeneralDetail] Selected remote is required');
    return remote;
  });

  readonly openRemoteConfigModal = output<{
    editTarget?: string;
  }>();
  readonly stopJob = output<StopJobEvent>();
  readonly startJob = output<StartJobEvent>();
  readonly deleteJob = output<number>();
  readonly retryDiskUsage = output<void>();

  // State
  private readonly allAutomations = this.automationService.automations;
  readonly currentAutomationCardIndex = signal(0);

  // Derivations
  readonly jobs = computed(() =>
    this.remoteFacade.jobs().filter(j => j.remote_name === this.selectedRemote().name)
  );
  readonly remoteAutomations = computed(() => {
    const allAutomations = this.allAutomations();
    const remote = this.selectedRemote();
    if (!remote) return [];
    return allAutomations.filter(automation => automation.remoteName === remote.name);
  });

  readonly hasAutomations = computed(() => this.remoteAutomations().length > 0);

  readonly currentAutomation = computed(
    () => this.remoteAutomations()[this.currentAutomationCardIndex()] ?? null
  );

  readonly viewActionConfigs = computed<ActionViewModel[]>(() => {
    const remote = this.selectedRemote();
    const selectedActions =
      remote.primaryActions && remote.primaryActions.length > 0
        ? remote.primaryActions
        : MODE_DEFAULTS['general'];

    const actions = this.remoteFacade.actionInProgress()[remote.name] ?? [];

    const models: ActionViewModel[] = [];
    selectedActions.forEach((key, index) => {
      const config = ACTION_CONFIGS.find(c => c.key === key);
      const meta = OPERATION_META[key];
      if (!config || !meta) return;

      const position = index + 1;
      const isActive = config.getActiveState(remote);
      const tooltip = isActive ? meta.stopTooltip : meta.startTooltip;
      const icon = isActive ? meta.stopIcon : meta.startIcon;
      const ariaLabel = this.translate.instant(tooltip);

      const isLoading = actions.some(
        a =>
          a.operationType === key ||
          a.type === key ||
          (key === 'mount' && a.type === 'unmount') ||
          (a.type === 'stop' && a.operationType === key)
      );

      models.push({
        key: config.key,
        label: config.label,
        icon,
        isSelected: true,
        isActive,
        position,
        canInteract: !isLoading,
        isLoading,
        tooltip,
        ariaLabel,
      });
    });
    return models;
  });

  readonly remoteConfigurationPanelConfig = computed<SettingsPanelConfig>(() => ({
    section: {
      key: 'remote-config',
      title: 'dashboard.generalDetail.remoteConfiguration',
      icon: 'wrench',
    },
    settings: this.selectedRemote().config,
    buttonLabel: 'dashboard.generalDetail.editConfiguration',
  }));

  readonly diskUsageConfig = computed<DiskUsage>(() => this.selectedRemote().status.diskUsage);

  readonly jobsPanelConfig = computed<JobsPanelConfig>(() => ({
    jobs: this.jobs(),
  }));

  private readonly selectedRemoteName = computed(() => this.selectedRemote().name);

  constructor() {
    effect(() => {
      this.selectedRemoteName();
      untracked(() => this.currentAutomationCardIndex.set(0));
    });
  }

  // --- Actions ---

  onChipClick(vc: ActionViewModel): void {
    if (vc.isLoading || !vc.canInteract) return;
    this.onToggleAction(vc.key);
  }

  onToggleAction(actionKey: PrimaryActionType): void {
    const remote = this.selectedRemote();
    const status = remote.status[actionKey as keyof Omit<RemoteStatus, 'diskUsage'>] as any;
    const isActive = !!status?.active;

    if (isActive) {
      const activeProfiles = status?.activeProfiles;
      const profileName = activeProfiles ? (Object.keys(activeProfiles)[0] ?? '') : '';
      if (!profileName) return;
      this.stopJob.emit({
        type: actionKey,
        remoteName: remote.name,
        profileName,
      });
    } else {
      const configured = status?.configuredProfiles as string[] | undefined;
      if (!configured || configured.length === 0) return;
      if (configured.length === 1) {
        this.startJob.emit({
          type: actionKey,
          remoteName: remote.name,
          profileName: configured[0],
        });
      }
    }
  }

  onEditRemoteConfiguration(): void {
    this.openRemoteConfigModal.emit({
      editTarget: 'remote',
    });
  }

  onConfigureActions(): void {
    const remote = this.selectedRemote();
    if (!remote) return;

    this.dialog
      .open(ActionSelectionModalComponent, {
        ...STANDARD_MODAL_SIZE,
        disableClose: true,
        data: {
          remoteName: remote.name,
          primaryActions: remote.primaryActions ?? [],
        },
        panelClass: 'mobile-sheet-dialog',
      })
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(async (result: PrimaryActionType[] | undefined) => {
        if (result !== undefined) {
          try {
            await this.remoteFacade.updateRemoteSettings(remote.name, { primaryActions: result });
          } catch (error) {
            console.error('Failed to update primary actions:', error);
          }
        }
      });
  }

  // --- Automation Helpers ---

  async toggleAutomation(automationId: string): Promise<void> {
    try {
      await this.automationService.toggleAutomation(automationId);
    } catch (error) {
      console.error('Error toggling automation:', error);
    }
  }

  onOpenAutomationInFiles(path: string): void {
    const { remote: remoteName, path: relativePath } = this.pathService.splitFsPath(path);
    void this.remoteFacade.openRemoteInFiles(remoteName, relativePath);
  }

  // --- Carousel ---

  nextAutomationCard(): void {
    this.currentAutomationCardIndex.update(i =>
      i < this.remoteAutomations().length - 1 ? i + 1 : i
    );
  }

  previousAutomationCard(): void {
    this.currentAutomationCardIndex.update(i => (i > 0 ? i - 1 : i));
  }

  goToAutomationCard(index: number): void {
    this.currentAutomationCardIndex.set(index);
  }
}
