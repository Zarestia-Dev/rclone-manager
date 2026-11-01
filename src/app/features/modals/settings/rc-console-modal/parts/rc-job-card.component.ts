import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { FormatEtaPipe, FormatFileSizePipe } from '@app/pipes';
import { RcConsoleService } from '../../../../../services/infrastructure/system/rc-console.service';
import {
  RcJobProgress,
  RcJobView,
  toJobProgress,
  toJobView,
} from '../../../../../shared/utils/rc/rc-job.util';
import { RcOutputComponent } from '../../../../../shared/components/rc-output/rc-output.component';

/** Milliseconds between two looks at a running job. */
const POLL_MS = 1000;
/** Failed looks in a row, with rclone not reached, before the job is given up on. */
const MAX_FAILED_LOOKS = 3;

/**
 * A job started with `_async=true`, followed until it finishes. It reads `job/status` for the
 * result and `core/stats` for the job's group to show the transfer progress.
 */
@Component({
  selector: 'app-rc-job-card',
  imports: [MatIconModule, TranslatePipe, FormatFileSizePipe, FormatEtaPipe, RcOutputComponent],
  templateUrl: './rc-job-card.component.html',
  styleUrl: './rc-job-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RcJobCardComponent implements OnInit {
  private readonly rcConsole = inject(RcConsoleService);
  private readonly destroyRef = inject(DestroyRef);

  readonly jobId = input.required<number>();
  readonly mask = input(true);

  readonly job = signal<RcJobView | null>(null);
  readonly progress = signal<RcJobProgress | null>(null);
  /** Set when `job/status` itself fails, for example after rclone restarted. */
  readonly lookupError = signal<string | null>(null);
  readonly stopping = signal(false);

  private timer?: ReturnType<typeof setTimeout>;
  private done = false;
  private failures = 0;

  ngOnInit(): void {
    this.destroyRef.onDestroy(() => {
      this.done = true;
      clearTimeout(this.timer);
    });
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopping.set(true);
    try {
      await this.rcConsole.call('job/stop', { jobid: this.jobId() });
    } finally {
      this.stopping.set(false);
    }
  }

  private async tick(): Promise<void> {
    if (this.done) return;

    try {
      const status = await this.rcConsole.call('job/status', { jobid: this.jobId() });
      if (this.done) return;
      if (!status.ok) {
        // An HTTP status means rclone answered with an error, such as an unknown job, and there is
        // nothing to wait for. Without one rclone was not reached, which may pass.
        if (status.status || !this.canRetry()) this.lookupError.set(errorText(status.body));
        else this.schedule();
        return;
      }
      this.failures = 0;

      const view = toJobView(status.body);
      this.job.set(view);

      if (view.group) {
        const stats = await this.rcConsole.call('core/stats', { group: view.group });
        if (!this.done && stats.ok) this.progress.set(toJobProgress(stats.body));
      }
      if (view.finished) return;
    } catch (err) {
      if (this.canRetry()) this.schedule();
      else this.lookupError.set(err instanceof Error ? err.message : String(err));
      return;
    }

    this.schedule();
  }

  /** Counts a failed look and says whether another one is worth trying. */
  private canRetry(): boolean {
    return ++this.failures <= MAX_FAILED_LOOKS;
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.tick(), POLL_MS);
  }
}

function errorText(body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' ? error : JSON.stringify(body);
}
