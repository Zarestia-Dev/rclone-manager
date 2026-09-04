import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { Automation, CronValidationResponse } from '@app/types';
import { EventListenersService } from '../infrastructure/system/event-listeners.service';

@Injectable({ providedIn: 'root' })
export class AutomationService extends TauriBaseService {
  private readonly _automations = signal<Automation[]>([]);
  public readonly automations = this._automations.asReadonly();

  private readonly eventListeners = inject(EventListenersService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    super();
    this.eventListeners
      .listenToAutomationsCacheChanged()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refreshAutomations());
    void this.refreshAutomations();
  }

  async getAutomations(): Promise<Automation[]> {
    const automations = await this.invokeCommand<Automation[]>('get_automations');
    this._automations.set(automations);
    return automations;
  }

  async getAutomation(automationId: string): Promise<Automation | null> {
    return this.invokeCommand<Automation | null>('get_automation', { automationId });
  }

  async toggleAutomation(automationId: string): Promise<Automation> {
    return this.invokeCommand<Automation>('toggle_automation', { automationId });
  }

  async validateCron(cronExpression: string): Promise<CronValidationResponse> {
    return this.invokeCommand<CronValidationResponse>('validate_cron', { cronExpression });
  }

  async reloadAutomations(): Promise<void> {
    await this.invokeCommand('reload_automations');
  }

  async reloadAutomationsFromConfigs(remoteConfigs: unknown): Promise<number> {
    return this.invokeCommand<number>('reload_automations_from_configs', {
      remote_configs: remoteConfigs,
    });
  }

  async clearAllAutomations(): Promise<void> {
    await this.invokeCommand('clear_all_automations');
  }

  public async refreshAutomations(): Promise<void> {
    try {
      await this.getAutomations();
    } catch (error) {
      console.error('Failed to refresh automations:', error);
    }
  }
}
