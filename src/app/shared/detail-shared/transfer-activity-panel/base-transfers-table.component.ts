import { Directive, inject, input, computed, signal, linkedSignal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { CompletedTransfer, JOB_STATUS, TransferStatus } from '@app/types';
import { relativeTimeLabel } from '../../utils/relative-time.util';
import { ActivityRow, effectiveTransferStatus, matchesActivitySearch } from './activity.utils';

@Directive()
export abstract class BaseTransfersTableComponent {
  readonly transfers = input.required<CompletedTransfer[]>();
  readonly searchTerm = input<string>('');
  readonly statusFilter = input<TransferStatus | null>(null);

  protected readonly translate = inject(TranslateService);

  readonly resolvingIds = signal<Set<string>>(new Set());

  readonly displayLimit = linkedSignal<
    { jobId: number | undefined; search: string; status: TransferStatus | null },
    number
  >({
    source: () => ({
      jobId: this.transfers()[0]?.jobid,
      search: this.searchTerm().trim().toLowerCase(),
      status: this.statusFilter(),
    }),
    computation: (source, previous) =>
      previous &&
      previous.source.jobId === source.jobId &&
      previous.source.search === source.search &&
      previous.source.status === source.status
        ? previous.value
        : 50,
  });

  protected readonly lang = toSignal(this.translate.onLangChange, {
    initialValue: null,
  });

  protected readonly filteredTransfers = computed(() => {
    const search = this.searchTerm().toLowerCase().trim();
    const status = this.statusFilter();
    if (!search && !status) return this.transfers();
    return this.transfers().filter(
      item =>
        (!status || effectiveTransferStatus(item) === status) && matchesActivitySearch(item, search)
    );
  });

  /** Enrich only the visible window, rather than every history entry on each poll. */
  protected readonly visibleTransfers = computed(() =>
    this.filteredTransfers().slice(0, this.displayLimit())
  );

  protected getRelativeTime(timestamp: string): string {
    const label = relativeTimeLabel(timestamp);
    return label ? this.translate.instant(label.key, label.params) : '';
  }

  /** Whether the given enriched item is currently being resolved. */
  isResolving(item: ActivityRow): boolean {
    return (
      this.resolvingIds().has(item.uniqueId) || item.resolveState?.status === JOB_STATUS.Running
    );
  }

  loadMore(): void {
    const total = this.filteredTransfers().length;
    this.displayLimit.update(limit => (limit < total ? Math.min(limit + 50, total) : limit));
  }

  /** Shared infinite-scroll handler bound from each subclass template. */
  onScroll(event: Event): void {
    const target = event.target as HTMLElement;
    if (!target) return;

    if (target.scrollHeight - (target.scrollTop + target.clientHeight) < 150) {
      this.loadMore();
    }
  }
}
