import {
  Directive,
  inject,
  input,
  computed,
  signal,
  effect,
  linkedSignal,
  untracked,
  type Signal,
} from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CompletedTransfer } from '@app/types';
import { TransferOperationsService } from './transfer-operations.service';

/**
 * Minimal contract shared by every "enriched" transfer shape produced by
 * subclasses. Both {@link EnrichedCompletedTransfer} and
 * {@link EnrichedCheckResult} satisfy this interface.
 */
export interface BaseEnrichedTransfer extends CompletedTransfer {
  uniqueId: string;
}

@Directive()
export abstract class BaseTransfersTableComponent<TEnriched extends BaseEnrichedTransfer> {
  readonly transfers = input.required<CompletedTransfer[]>();
  readonly searchTerm = input<string>('');

  protected readonly translate = inject(TranslateService);
  protected readonly ops = inject(TransferOperationsService);

  readonly hiddenIds = signal<Set<string>>(new Set());
  readonly resolvingIds = signal<Set<string>>(new Set());

  readonly displayLimit = linkedSignal({
    source: () => [this.transfers(), this.searchTerm()] as const,
    computation: () => 50,
  });

  protected readonly lang = toSignal(this.translate.onLangChange, {
    initialValue: null,
  });

  private readonly remotesList = computed(
    () => {
      const remotes = new Set<string>();
      for (const t of this.transfers()) {
        if (t.srcFs) remotes.add(t.srcFs);
        if (t.dstFs) remotes.add(t.dstFs);
      }
      return Array.from(remotes).sort();
    },
    {
      equal: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    }
  );

  private readonly _preloadEffect = effect(() => {
    const remotes = this.remotesList();
    if (remotes.length > 0) {
      untracked(() => this.ops.preloadFeatures(this.transfers()));
    }
  });

  /**
   * Subclass-specific enrichment + filtering pipeline. Must return the full
   * filtered list (the base class applies the {@link slicedItems} window).
   */
  protected abstract readonly processedItems: Signal<TEnriched[]>;

  /** Shared slice for the infinite-scroll viewport. */
  readonly slicedItems = computed(() => this.processedItems().slice(0, this.displayLimit()));

  /**
   * Format a completed-at timestamp as a localized relative-time string
   * (e.g. "just now", "5 minutes ago", "3 hours ago", "2 days ago").
   */
  protected getRelativeTime(timestamp: string): string {
    const diff = Date.now() - Date.parse(timestamp);
    const minutes = Math.floor(diff / 60000);
    if (minutes <= 0) return this.translate.instant('shared.transferActivity.time.justNow');
    const hours = Math.floor(minutes / 60);
    if (hours <= 0)
      return this.translate.instant('shared.transferActivity.time.minutesAgo', {
        count: minutes,
      });
    const days = Math.floor(hours / 24);
    if (days <= 0)
      return this.translate.instant('shared.transferActivity.time.hoursAgo', {
        count: hours,
      });
    return this.translate.instant('shared.transferActivity.time.daysAgo', {
      count: days,
    });
  }

  /** Whether the given enriched item is currently being resolved. */
  isResolving(item: TEnriched): boolean {
    return this.resolvingIds().has(item.uniqueId) || item.resolveState?.status === 'Running';
  }

  /** Shared infinite-scroll handler bound from each subclass template. */
  onScroll(event: Event): void {
    const target = event.target as HTMLElement;
    if (!target) return;

    if (target.scrollHeight - (target.scrollTop + target.clientHeight) < 150) {
      const currentLimit = this.displayLimit();
      const totalCount = this.processedItems().length;
      if (currentLimit < totalCount) {
        this.displayLimit.set(Math.min(currentLimit + 50, totalCount));
      }
    }
  }
}
