import { Injectable, signal } from '@angular/core';
import { Observable, from } from 'rxjs';
import {
  AlertAction,
  AlertHistoryFilter,
  AlertHistoryPage,
  AlertRecord,
  AlertRule,
  AlertStats,
} from '../../shared/types/alerts';
// Assuming your Tauri Base Service path remains the same
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { ALERT_FIRED } from '@app/types';

@Injectable({
  providedIn: 'root',
})
export class AlertService extends TauriBaseService {
  // Signals for zoneless reactivity
  unacknowledgedCount = signal<number>(0);
  lastAlert = signal<AlertRecord | null>(null);

  constructor() {
    super();
    this.initRealtime();
  }

  private initRealtime() {
    this.listenToEvent<string>(ALERT_FIRED).subscribe(payload => {
      console.log('🔔 Alert fired:', payload);
      this.getAlertStats().subscribe({
        next: stats => {
          this.unacknowledgedCount.set(stats.unacknowledged);
        },
        error: err => console.error('Failed to refresh unacknowledged count', err),
      });
    });
  }

  // ===========================================================================
  // RULES
  // ===========================================================================

  getAlertRules(): Observable<AlertRule[]> {
    return from(this.invokeCommand<AlertRule[]>('get_alert_rules'));
  }

  saveAlertRule(rule: AlertRule): Observable<AlertRule> {
    return from(this.invokeCommand<AlertRule>('save_alert_rule', { rule }));
  }

  deleteAlertRule(id: string): Observable<void> {
    return from(this.invokeCommand<void>('delete_alert_rule', { id }));
  }

  toggleAlertRule(id: string, enabled: boolean): Observable<AlertRule> {
    return from(this.invokeCommand<AlertRule>('toggle_alert_rule', { id, enabled }));
  }

  // ===========================================================================
  // ACTIONS
  // ===========================================================================

  getAlertActions(): Observable<AlertAction[]> {
    return from(this.invokeCommand<AlertAction[]>('get_alert_actions'));
  }

  saveAlertAction(action: AlertAction): Observable<AlertAction> {
    return from(this.invokeCommand<AlertAction>('save_alert_action', { action }));
  }

  deleteAlertAction(id: string): Observable<void> {
    return from(this.invokeCommand<void>('delete_alert_action', { id }));
  }

  testAlertAction(id: string): Observable<boolean> {
    return from(this.invokeCommand<boolean>('test_alert_action', { id }));
  }

  // ===========================================================================
  // HISTORY
  // ===========================================================================

  getAlertHistory(filter: AlertHistoryFilter = {}): Observable<AlertHistoryPage> {
    return from(this.invokeCommand<AlertHistoryPage>('get_alert_history', { filter }));
  }

  acknowledgeAlert(id: string): Observable<void> {
    return from(this.invokeCommand<void>('acknowledge_alert', { id }));
  }

  acknowledgeAllAlerts(): Observable<void> {
    return from(this.invokeCommand<void>('acknowledge_all_alerts'));
  }

  clearAlertHistory(): Observable<void> {
    return from(this.invokeCommand<void>('clear_alert_history'));
  }

  getAlertStats(): Observable<AlertStats> {
    return from(this.invokeCommand<AlertStats>('get_alert_stats'));
  }
}
