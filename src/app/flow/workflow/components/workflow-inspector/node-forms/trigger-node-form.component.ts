import { Component, ChangeDetectionStrategy, input, output, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatOptionModule } from '@angular/material/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { toString as cronstrue } from 'cronstrue';
import { getCronstrueLocale } from '../../../../../services/i18n/cron-locale.mapper';
import { WorkflowNode } from '../../../types/workflow.types';
import { AlertBannerComponent } from '../../../../../shared/components/alert-banner/alert-banner.component';
import { FileSystemService } from '../../../../../services/operations/file-system.service';

@Component({
  selector: 'app-trigger-node-form',
  imports: [
    CommonModule,
    FormsModule,
    MatIconModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatOptionModule,
    TranslatePipe,
    AlertBannerComponent,
  ],
  templateUrl: './trigger-node-form.component.html',
  styleUrl: '../workflow-inspector.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TriggerNodeFormComponent {
  private readonly translate = inject(TranslateService);
  private readonly fileSystemService = inject(FileSystemService, { optional: true });

  readonly node = input.required<WorkflowNode>();
  readonly nodeConfig = input.required<Record<string, unknown>>();
  readonly allProfiles = input<string[]>([]);

  readonly configChange = output<{ key: string; value: unknown }>();
  readonly openDetailed = output<void>();

  readonly isCronInvalid = computed(() => {
    const expr = String(this.nodeConfig()['cronExpression'] || '').trim();
    if (!expr) return false;
    try {
      cronstrue(expr, {
        locale: getCronstrueLocale(this.translate.getCurrentLang() ?? 'en-US'),
        throwExceptionOnParseError: true,
      });
      return false;
    } catch {
      return true;
    }
  });

  readonly cronHumanReadable = computed(() => {
    const expr = String(this.nodeConfig()['cronExpression'] || '').trim();
    if (!expr) return '';
    try {
      return cronstrue(expr, {
        locale: getCronstrueLocale(this.translate.getCurrentLang() ?? 'en-US'),
        throwExceptionOnParseError: true,
      });
    } catch {
      return this.translate.instant('flow.workflow.inspector.invalidCron');
    }
  });

  readonly cronTooltip = computed(() => {
    return String(this.nodeConfig()['cronExpression'] || '').trim();
  });

  readonly watchPath = computed(() => {
    const p = this.nodeConfig()['watchPaths'];
    return Array.isArray(p) && p.length > 0 ? String(p[0]) : '';
  });

  onFieldChange(key: string, value: unknown): void {
    this.configChange.emit({ key, value });
  }

  onWatchPathChange(val: string): void {
    this.onFieldChange('watchPaths', [val]);
  }

  async browseWatchFolder(): Promise<void> {
    if (!this.fileSystemService) return;
    try {
      const path = await this.fileSystemService.selectFolder();
      if (path) {
        this.onWatchPathChange(path);
      }
    } catch {
      // user cancelled
    }
  }

  applyAppStartPreset(seconds: number): void {
    this.onFieldChange('delaySeconds', seconds);
  }

  applyCronPreset(cronExpr: string): void {
    this.onFieldChange('cronExpression', cronExpr);
  }

  applyDebouncePreset(seconds: number): void {
    this.onFieldChange('debounceSeconds', seconds);
  }
}
