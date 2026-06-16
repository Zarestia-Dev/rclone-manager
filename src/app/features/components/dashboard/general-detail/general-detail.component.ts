import { Component, inject, signal, computed, output, effect, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { CommonModule, TitleCasePipe } from '@angular/common';
import {
  DiskUsage,
  JobsPanelConfig,
  PrimaryActionType,
  SettingsPanelConfig,
  StopJobEvent,
  ActionViewModel,
  ACTION_CONFIGS,
} from '@app/types';
import {
  DiskUsagePanelComponent,
  JobsPanelComponent,
  SettingsPanelComponent,
  AutomationCardComponent,
} from '../../../../shared/detail-shared';
import { IconService } from 'src/app/services/ui/icon.service';
import { AutomationService } from 'src/app/services/operations/automation.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-general-detail',
  standalone: true,
  imports: [
    CommonModule,
    TitleCasePipe,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
    SettingsPanelComponent,
    DiskUsagePanelComponent,
    JobsPanelComponent,
    TranslateModule,
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
  readonly deleteJob = output<number>();
  readonly togglePrimaryAction = output<PrimaryActionType>();
  readonly retryDiskUsage = output<void>();

  // State
  private readonly allAutomations = this.automationService.automations;
  readonly currentAutomationCardIndex = signal(0);

  protected readonly maxPrimaryActions = 3;

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
    const selectedActions = remote.primaryActions ?? [];
    const canSelectMore = selectedActions.length < this.maxPrimaryActions;

    return ACTION_CONFIGS.map(config => {
      const isSelected = selectedActions.includes(config.key);
      const position = isSelected ? selectedActions.indexOf(config.key) + 1 : 0;
      const label = this.translate.instant(config.label);

      return {
        key: config.key,
        label: config.label,
        icon: config.icon,
        isSelected,
        isActive: config.getActiveState(remote),
        position,
        canInteract: isSelected || canSelectMore,
        tooltip: config.getTooltip(remote),
        ariaLabel: isSelected
          ? this.translate.instant('dashboard.generalDetail.quickActionSelected', {
              label,
              position,
            })
          : this.translate.instant('dashboard.generalDetail.toggleQuickAction', { label }),
      };
    });
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

  onToggleAction(actionKey: PrimaryActionType): void {
    const config = this.viewActionConfigs().find(c => c.key === actionKey);
    if (config?.canInteract) {
      this.togglePrimaryAction.emit(actionKey);
    }
  }

  onEditRemoteConfiguration(): void {
    this.openRemoteConfigModal.emit({
      editTarget: 'remote',
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
