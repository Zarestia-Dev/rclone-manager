import { Injectable, signal, computed, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, from, tap, finalize } from 'rxjs';
import {
  AlertAction,
  AlertActionKind,
  AlertHistoryFilter,
  AlertHistoryPage,
  AlertRecord,
  AlertRule,
  AlertStats,
} from '../../shared/types/alerts';
import { TauriBaseService } from '../infrastructure/platform/tauri-base.service';
import { ALERT_FIRED } from '@app/types';

@Injectable({ providedIn: 'root' })
export class AlertService extends TauriBaseService {
  private readonly destroyRef = inject(DestroyRef);

  // ── Raw local caches ─────────────────────────────────────────────────────
  private readonly _history = signal<AlertRecord[]>([]);
  private readonly _rules = signal<AlertRule[]>([]);
  private readonly _actions = signal<AlertAction[]>([]);

  // ── Public state ─────────────────────────────────────────────────────────
  readonly stats = signal<AlertStats>({
    total: 0,
    unacknowledged: 0,
    critical: 0,
    high: 0,
    total_fired: 0,
    by_severity: {},
    by_rule: {},
  });
  readonly isLoading = signal(false);

  // Filters
  readonly filter = signal<AlertHistoryFilter>({ limit: 100 });
  readonly searchTerm = signal('');
  readonly rulesSearchTerm = signal('');
  readonly actionsSearchTerm = signal('');

  readonly testingActionIds = signal<Set<string>>(new Set());

  // ── Derived / Filtered views (O(1) updates) ──────────────────────────────
  readonly unacknowledged = computed(() => this.stats().unacknowledged);

  readonly history = computed(() => {
    const s = this.searchTerm().toLowerCase();
    return s
      ? this._history().filter(
          a =>
            a.title.toLowerCase().includes(s) ||
            a.body.toLowerCase().includes(s) ||
            a.remote?.toLowerCase().includes(s) ||
            a.profile?.toLowerCase().includes(s)
        )
      : this._history();
  });

  readonly rules = computed(() => {
    const s = this.rulesSearchTerm().toLowerCase();
    return s ? this._rules().filter(r => r.name.toLowerCase().includes(s)) : this._rules();
  });

  readonly actions = computed(() => {
    const s = this.actionsSearchTerm().toLowerCase();
    return s ? this._actions().filter(a => a.name.toLowerCase().includes(s)) : this._actions();
  });

  readonly actionsMap = computed(() => new Map(this._actions().map(a => [a.id, a])));

  // ────────────────────────────────────────────────────────────────────────

  constructor() {
    super();
    this.loadInitialData();
    this.initRealtime();
  }

  // ── Data Loading (No more N+1 polling loops) ───────────────────────────

  private loadInitialData(): void {
    this.isLoading.set(true);

    // Load configurations once
    from(this.invokeCommand<AlertRule[]>('get_alert_rules')).subscribe(r => this._rules.set(r));
    from(this.invokeCommand<AlertAction[]>('get_alert_actions')).subscribe(a =>
      this._actions.set(a)
    );
    from(this.invokeCommand<AlertStats>('get_alert_stats')).subscribe(s => this.stats.set(s));

    // Load initial history
    this.fetchHistory();
  }

  /**
   * Called only when the user explicitly changes a filter via the UI.
   */
  public fetchHistory(): void {
    this.isLoading.set(true);
    from(this.invokeCommand<AlertHistoryPage>('get_alert_history', { filter: this.filter() }))
      .pipe(finalize(() => this.isLoading.set(false)))
      .subscribe(page => this._history.set(page.items));
  }

  private initRealtime(): void {
    this.listenToEvent<AlertRecord>(ALERT_FIRED)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(newAlert => {
        this._history.update(h => {
          const updated = [newAlert, ...h];
          return updated.slice(0, this.filter().limit || 100);
        });

        this.stats.update(s => ({
          ...s,
          unacknowledged: newAlert.acknowledged ? s.unacknowledged : s.unacknowledged + 1,
          total: s.total + 1,
        }));
      });
  }

  saveAlertRule(rule: AlertRule): Observable<AlertRule> {
    return from(this.invokeCommand<AlertRule>('save_alert_rule', { rule })).pipe(
      tap(savedRule => {
        this._rules.update(rules => {
          const idx = rules.findIndex(r => r.id === savedRule.id);
          if (idx > -1) {
            const next = [...rules];
            next[idx] = savedRule;
            return next;
          }
          return [...rules, savedRule];
        });
      })
    );
  }

  deleteAlertRule(id: string): Observable<void> {
    return from(this.invokeCommand<void>('delete_alert_rule', { id })).pipe(
      tap(() => this._rules.update(rules => rules.filter(r => r.id !== id)))
    );
  }

  toggleAlertRule(id: string, enabled: boolean): Observable<AlertRule> {
    return from(this.invokeCommand<AlertRule>('toggle_alert_rule', { id, enabled })).pipe(
      tap(updated =>
        this._rules.update(rules => rules.map(r => (r.id === updated.id ? updated : r)))
      )
    );
  }

  // ── Optimistic CRUD for Actions ────────────────────────────────────────

  saveAlertAction(action: AlertAction): Observable<AlertAction> {
    return from(this.invokeCommand<AlertAction>('save_alert_action', { action })).pipe(
      tap(savedAction => {
        this._actions.update(actions => {
          const idx = actions.findIndex(a => a.id === savedAction.id);
          if (idx > -1) {
            const next = [...actions];
            next[idx] = savedAction;
            return next;
          }
          return [...actions, savedAction];
        });
      })
    );
  }

  deleteAlertAction(id: string): Observable<void> {
    return from(this.invokeCommand<void>('delete_alert_action', { id })).pipe(
      tap(() => this._actions.update(actions => actions.filter(a => a.id !== id)))
    );
  }

  testAlertAction(id: string): Observable<boolean> {
    this.testingActionIds.update(set => new Set(set).add(id));
    return from(this.invokeCommand<boolean>('test_alert_action', { id })).pipe(
      finalize(() => {
        this.testingActionIds.update(set => {
          const next = new Set(set);
          next.delete(id);
          return next;
        });
      })
    );
  }

  // ── History Actions ──────────────────────────────────────────────────────

  acknowledgeAlert(id: string): Observable<void> {
    return from(this.invokeCommand<void>('acknowledge_alert', { id })).pipe(
      tap(() => {
        this._history.update(h => h.map(a => (a.id === id ? { ...a, acknowledged: true } : a)));
        this.stats.update(s => ({ ...s, unacknowledged: Math.max(0, s.unacknowledged - 1) }));
      })
    );
  }

  acknowledgeAllAlerts(): Observable<void> {
    return from(this.invokeCommand<void>('acknowledge_all_alerts')).pipe(
      tap(() => {
        this._history.update(h => h.map(a => ({ ...a, acknowledged: true })));
        this.stats.update(s => ({ ...s, unacknowledged: 0 }));
      })
    );
  }

  clearAlertHistory(): Observable<void> {
    return from(this.invokeCommand<void>('clear_alert_history')).pipe(
      tap(() => {
        this._history.set([]);
        this.stats.update(s => ({ ...s, unacknowledged: 0, total: 0 }));
      })
    );
  }

  getTemplateKeys(): Observable<string[]> {
    return from(this.invokeCommand<string[]>('get_alert_template_keys'));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  getActionIcon(kind: AlertActionKind): string {
    switch (kind) {
      case 'os_toast':
        return 'bell';
      case 'webhook':
        return 'globe';
      case 'script':
        return 'file-code';
      default:
        return 'bolt';
    }
  }
}
