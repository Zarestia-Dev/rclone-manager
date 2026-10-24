import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  inject,
  signal,
  effect,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { PathDisplayComponent } from '../path-display/path-display.component';
import {
  OperationControlConfig,
  PrimaryActionType,
  LocalDiskUsage,
  OPERATION_ICONS,
  SYNC_TYPES,
} from '@app/types';
import { FormatFileSizePipe } from '@app/pipes';
import { SystemInfoService } from 'src/app/services/infrastructure/system/system-info.service';
import { TranslatePipe } from '@ngx-translate/core';

@Component({
  selector: 'app-operation-control',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatExpansionModule,
    MatProgressBarModule,
    MatSlideToggleModule,
    PathDisplayComponent,
    TranslatePipe,
    FormatFileSizePipe,
  ],
  templateUrl: './operation-control.component.html',
  styleUrls: ['./operation-control.component.scss', '../../../styles/_panel-actions.scss'],
})
export class OperationControlComponent {
  readonly config = input.required<OperationControlConfig>();
  readonly dryRun = input<boolean>(false);
  readonly resync = input<boolean>(false);
  readonly startJob = output<PrimaryActionType>();
  readonly stopJob = output<PrimaryActionType>();
  readonly openPath = output<string>();
  readonly toggleDryRun = output<void>();
  readonly toggleResync = output<void>();

  private readonly systemInfo = inject(SystemInfoService);

  readonly isExpanded = signal(false);
  readonly diskUsage = signal<LocalDiskUsage | null>(null);
  readonly isDiskUsageLoading = signal(false);

  readonly diskUsagePercentage = computed(() => {
    const usage = this.diskUsage();
    if (!usage || !usage.total || usage.total <= 0) return 0;
    return Math.min(100, Math.max(0, (usage.used / usage.total) * 100));
  });

  readonly diskUsageColor = computed<'primary' | 'accent' | 'warn'>(() => {
    const pct = this.diskUsagePercentage();
    if (pct > 90) return 'warn';
    if (pct > 70) return 'accent';
    return 'primary';
  });

  readonly isOperationsType = computed(() =>
    (SYNC_TYPES as string[]).includes(this.config().operationType)
  );

  readonly shouldPollDiskUsage = computed(() => {
    const { operationType, isActive, pathConfig } = this.config();
    const destination = pathConfig.destination ?? '';
    return (
      operationType === 'mount' &&
      isActive &&
      pathConfig.hasDestination &&
      destination.trim().length > 0
    );
  });

  constructor() {
    effect(() => {
      if (!this.shouldPollDiskUsage()) {
        this.diskUsage.set(null);
        this.isDiskUsageLoading.set(false);
        return;
      }
      this.isDiskUsageLoading.set(true);
      const destination = this.config().pathConfig.destination ?? '';
      const fetchUsage = async (): Promise<void> => {
        try {
          const usage = await this.systemInfo.getLocalDiskUsage(destination);
          this.diskUsage.set(usage);
        } catch {
          this.diskUsage.set(null);
        } finally {
          this.isDiskUsageLoading.set(false);
        }
      };

      void fetchUsage();
    });
  }

  handleQuickAction(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    const { isActive, operationType } = this.config();
    if (isActive) {
      this.stopJob.emit(operationType);
    } else {
      this.startJob.emit(operationType);
    }
  }

  readonly operationIcon = computed(
    () => OPERATION_ICONS[this.config().operationType] ?? 'refresh'
  );

  readonly buttonClass = computed(() => {
    const { isActive, cssClass } = this.config();
    return isActive ? 'warn' : (cssClass ?? '');
  });
}
