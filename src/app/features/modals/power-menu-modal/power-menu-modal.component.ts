import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialogRef } from '@angular/material/dialog';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import {
  isHeadlessMode,
  isMobile,
  isIOS,
} from '../../../services/infrastructure/platform/api-client.service';
import { NotificationService } from '../../../services/ui/notification.service';
import { AppLifecycleService } from '../../../services/infrastructure/system/app-lifecycle.service';
import { RemoteFacadeService } from '../../../services/facade/remote-facade.service';
import { SystemPowerAction } from '@app/types';

export interface PowerActionItem {
  id: string;
  icon: string;
  titleKey: string;
  descKey: string;
  color:
    | 'var(--destructive-color)'
    | 'var(--accent-color)'
    | 'var(--orange)'
    | 'var(--warn-color)'
    | 'var(--purple)'
    | 'var(--dim-color)';
  action: () => Promise<void>;
}

@Component({
  selector: 'app-power-menu-modal',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule, TranslatePipe],
  templateUrl: './power-menu-modal.component.html',
  styleUrls: ['./power-menu-modal.component.scss', '../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PowerMenuModalComponent {
  private readonly dialogRef = inject(MatDialogRef<PowerMenuModalComponent>);
  private readonly appLifecycle = inject(AppLifecycleService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly remoteFacade = inject(RemoteFacadeService);

  readonly isExecuting = signal(false);
  readonly executingMessageKey = signal<string>('powerMenu.executing');
  readonly selectedAction = signal<PowerActionItem | null>(null);

  readonly activeJobsCount = computed(
    () => this.remoteFacade.jobs().filter(j => j.status === 'Running' && !j.parent_job_id).length
  );
  readonly activeMountsCount = computed(() => this.remoteFacade.mountedRemotes().length);
  readonly activeServesCount = computed(() => this.remoteFacade.runningServes().length);

  readonly hasActiveOperations = computed(
    () => this.activeJobsCount() > 0 || this.activeMountsCount() > 0 || this.activeServesCount() > 0
  );

  readonly isNativeMobile = signal(!isHeadlessMode() && isMobile());
  readonly isIOS = signal(!isHeadlessMode() && isIOS());

  readonly powerActions = computed((): PowerActionItem[] => {
    const isMobileNative = this.isNativeMobile();
    const isIosNative = this.isIOS();

    const allActions: PowerActionItem[] = [
      {
        id: 'shutdown-app',
        icon: 'power-off',
        titleKey: 'powerMenu.actions.shutdownApp.title',
        descKey: 'powerMenu.actions.shutdownApp.desc',
        color: 'var(--destructive-color)',
        action: () => this.handleShutdownApp(),
      },
      {
        id: 'restart-app',
        icon: 'rotate-right',
        titleKey: 'powerMenu.actions.restartApp.title',
        descKey: 'powerMenu.actions.restartApp.desc',
        color: 'var(--accent-color)',
        action: () => this.handleRestartApp(),
      },
      {
        id: 'emergency-stop',
        icon: 'stop',
        titleKey: 'powerMenu.actions.emergencyStop.title',
        descKey: 'powerMenu.actions.emergencyStop.desc',
        color: 'var(--orange)',
        action: () => this.handleEmergencyStop(),
      },
      {
        id: 'system-shutdown',
        icon: 'server',
        titleKey: 'powerMenu.actions.systemShutdown.title',
        descKey: 'powerMenu.actions.systemShutdown.desc',
        color: 'var(--warn-color)',
        action: () => this.handleSystemPower('shutdown'),
      },
      {
        id: 'system-sleep',
        icon: 'bolt',
        titleKey: 'powerMenu.actions.systemSleep.title',
        descKey: 'powerMenu.actions.systemSleep.desc',
        color: 'var(--purple)',
        action: () => this.handleSystemPower('sleep'),
      },
      {
        id: 'system-lock',
        icon: 'lock',
        titleKey: 'powerMenu.actions.systemLock.title',
        descKey: 'powerMenu.actions.systemLock.desc',
        color: 'var(--dim-color)',
        action: () => this.handleSystemPower('lock'),
      },
    ];

    if (isMobileNative) {
      // Native Android/iOS cannot execute OS-level power actions (device shutdown/sleep/lock)
      return allActions.filter(a => {
        if (a.id === 'system-shutdown' || a.id === 'system-sleep' || a.id === 'system-lock') {
          return false;
        }
        // Apple App Store rejects apps with an exit/quit button, but Android allows it
        if (a.id === 'shutdown-app' && isIosNative) {
          return false;
        }
        return true;
      });
    }

    return allActions;
  });

  selectAction(action: PowerActionItem): void {
    this.selectedAction.set(action);
  }

  clearSelection(): void {
    this.selectedAction.set(null);
  }

  async executeAction(action: PowerActionItem): Promise<void> {
    await action.action();
  }

  close(): void {
    if (!this.isExecuting()) {
      this.dialogRef.close();
    }
  }

  async handleShutdownApp(): Promise<void> {
    this.isExecuting.set(true);
    this.executingMessageKey.set('powerMenu.status.shuttingDown');

    try {
      await this.appLifecycle.shutdownApp();
    } catch (err) {
      this.isExecuting.set(false);
      this.notificationService.showError(String(err));
    }
  }

  async handleRestartApp(): Promise<void> {
    this.isExecuting.set(true);
    this.executingMessageKey.set('powerMenu.status.restarting');

    try {
      await this.appLifecycle.relaunchApp();
    } catch (err) {
      this.isExecuting.set(false);
      this.notificationService.showError(String(err));
    }
  }

  async handleEmergencyStop(): Promise<void> {
    this.isExecuting.set(true);
    this.executingMessageKey.set('powerMenu.status.stoppingOperations');

    try {
      await this.remoteFacade.emergencyStopAll();
      this.isExecuting.set(false);
      this.notificationService.showSuccess(
        this.translate.instant('powerMenu.status.emergencyStopSuccess')
      );
      this.dialogRef.close();
    } catch (err) {
      this.isExecuting.set(false);
      this.notificationService.showError(String(err));
    }
  }

  async handleSystemPower(action: SystemPowerAction): Promise<void> {
    this.isExecuting.set(true);
    this.executingMessageKey.set(
      action === 'shutdown'
        ? 'powerMenu.status.hostShuttingDown'
        : action === 'sleep'
          ? 'powerMenu.status.hostSleeping'
          : 'powerMenu.status.hostLocking'
    );

    try {
      await this.appLifecycle.executeSystemPower(action);
      this.isExecuting.set(false);
      if (action !== 'shutdown') {
        this.dialogRef.close();
      }
    } catch (err) {
      this.isExecuting.set(false);
      this.notificationService.showError(String(err));
    }
  }
}
