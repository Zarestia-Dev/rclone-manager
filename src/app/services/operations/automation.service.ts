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

  async toggleAutomation(automationId: string): Promise<Automation> {
    return this.invokeCommand<Automation>('toggle_automation', { automationId });
  }

  async validateCron(cronExpression: string): Promise<CronValidationResponse> {
    return this.invokeCommand<CronValidationResponse>('validate_cron', { cronExpression });
  }

  public async refreshAutomations(): Promise<void> {
    try {
      const automations = await this.invokeCommand<Automation[]>('get_automations');
      this._automations.set(automations);
    } catch (error) {
      console.error('Failed to refresh automations:', error);
    }
  }
}
