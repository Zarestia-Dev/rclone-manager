import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { WorkflowNode } from '../../types/workflow.types';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { CronInputComponent } from '../../../../shared/remote-config/cron-input/cron-input.component';
import { CronValidationResponse } from '@app/types';

export interface CronEditorModalData {
  node: WorkflowNode;
}

@Component({
  selector: 'app-cron-editor-modal',
  imports: [CommonModule, MatButtonModule, MatIconModule, TranslatePipe, CronInputComponent],
  templateUrl: './cron-editor-modal.component.html',
  styleUrl: '../../../../styles/_shared-modal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(keydown.escape)': 'dismiss()',
  },
})
export class CronEditorModalComponent {
  readonly dialogRef = inject(MatDialogRef<CronEditorModalComponent>);
  readonly data: CronEditorModalData = inject(MAT_DIALOG_DATA);
  private readonly workflowState = inject(WorkflowStateService, { optional: true });

  readonly cronExpression = signal<string>(
    (this.data?.node?.config?.['cronExpression'] as string) || '0 2 * * *'
  );
  readonly isValid = signal<boolean>(true);

  onCronChange(newCron: string | null): void {
    if (newCron) {
      this.cronExpression.set(newCron);
    }
  }

  onValidationChange(res: CronValidationResponse): void {
    this.isValid.set(res?.isValid ?? true);
  }

  dismiss(): void {
    this.dialogRef.close();
  }

  save(): void {
    const cron = this.cronExpression();
    if (this.data?.node?.id && this.workflowState) {
      this.workflowState.updateNodeConfig(this.data.node.id, {
        cronExpression: cron,
      });
    }
    this.dialogRef.close(cron);
  }
}
