import { Component, ChangeDetectionStrategy, inject, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe } from '@ngx-translate/core';

import { UserPresetTemplate, TemplateCategory } from '@app/types';
import { UserTemplateService } from 'src/app/services/remote/user-template.service';
import { ModalService } from 'src/app/services/ui/modal.service';

export interface ApplyTemplateEvent {
  sourceName: string;
  values: Partial<Record<TemplateCategory, Record<string, unknown>>>;
}

@Component({
  selector: 'app-preset-template-bar',
  imports: [MatButtonModule, MatIconModule, MatListModule, CdkMenuModule, TranslatePipe],
  templateUrl: './preset-template-bar.component.html',
  styleUrl: './preset-template-bar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PresetTemplateBarComponent {
  private readonly modalService = inject(ModalService);
  readonly userTemplateService = inject(UserTemplateService);

  readonly currentValues = input<Partial<Record<TemplateCategory, Record<string, unknown>>>>({});
  readonly remoteType = input<string>('');
  readonly variant = input<'button' | 'sidebar-item'>('sidebar-item');

  readonly applyTemplate = output<ApplyTemplateEvent>();
  readonly applyDefaultPresets = output<void>();

  onSelectTemplate(tpl: UserPresetTemplate): void {
    this.applyTemplate.emit({
      sourceName: tpl.name,
      values: tpl.values,
    });
  }

  openSaveDialog(): void {
    const dialogRef = this.modalService.openTemplateManager({
      mode: 'save',
      currentValues: this.currentValues(),
      remoteType: this.remoteType(),
    });

    dialogRef
      .afterClosed()
      .subscribe((res: { action?: string; template?: UserPresetTemplate } | undefined) => {
        if (res?.action === 'saved') {
          // Template saved
        }
      });
  }

  openManageDialog(): void {
    this.modalService.openTemplateManager({
      mode: 'manage',
    });
  }
}
