import { Component, ChangeDetectionStrategy, inject, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import { UserPresetTemplate, TemplateCategory } from '@app/types';
import { UserTemplateService } from 'src/app/services/remote/user-template.service';
import { RemotePresetsService } from 'src/app/services/remote/remote-presets';
import { ModalService } from 'src/app/services/ui/modal.service';
import { NotificationService } from 'src/app/services/ui/notification.service';

export interface ApplyTemplateEvent {
  sourceName: string;
  values: Partial<Record<TemplateCategory, Record<string, unknown>>>;
}

@Component({
  selector: 'app-preset-template-bar',
  imports: [MatIconModule, MatListModule, CdkMenuModule, TranslatePipe],
  templateUrl: './preset-template-bar.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PresetTemplateBarComponent {
  private readonly modalService = inject(ModalService);
  private readonly notificationService = inject(NotificationService);
  private readonly translate = inject(TranslateService);
  private readonly remotePresetsService = inject(RemotePresetsService);
  readonly userTemplateService = inject(UserTemplateService);

  readonly remoteType = input<string>();
  readonly vendor = input<string>();
  readonly applicableCategories = input<readonly TemplateCategory[]>();
  readonly currentValues = input<Partial<Record<TemplateCategory, Record<string, unknown>>>>({});

  readonly applyTemplate = output<ApplyTemplateEvent>();

  onSelectTemplate(tpl: UserPresetTemplate): void {
    this.openApplyModal(tpl);
  }

  onApplyDefaultPresets(): void {
    const rType = this.remoteType();
    if (!rType) {
      const warningMsg = this.translate.instant('wizards.presets.noRemoteSelected');
      this.notificationService.showWarning(
        warningMsg !== 'wizards.presets.noRemoteSelected'
          ? warningMsg
          : 'Please select a remote first'
      );
      return;
    }

    const presetValues = this.remotePresetsService.resolvePresets(rType, this.vendor());
    const allowed = this.applicableCategories();
    const filteredPresetValues: Partial<Record<TemplateCategory, Record<string, unknown>>> = {};
    for (const [cat, vals] of Object.entries(presetValues)) {
      if (!allowed || allowed.includes(cat as TemplateCategory)) {
        filteredPresetValues[cat as TemplateCategory] = vals as Record<string, unknown>;
      }
    }

    const defaultTemplate: UserPresetTemplate = {
      id: '__default_presets__',
      name: this.translate.instant('templates.defaultPresets'),
      description: this.translate.instant('templates.defaultPresetsDesc'),
      values: filteredPresetValues,
    };

    this.openApplyModal(defaultTemplate);
  }

  private openApplyModal(tpl: UserPresetTemplate): void {
    const dialogRef = this.modalService.openApplyTemplate({
      template: tpl,
      currentValues: this.currentValues(),
      applicableCategories: this.applicableCategories(),
    });

    dialogRef.afterClosed().subscribe(res => {
      if (res?.applied && res.values) {
        this.applyTemplate.emit({
          sourceName: tpl.name,
          values: res.values,
        });
      }
    });
  }

  openSaveDialog(): void {
    const dialogRef = this.modalService.openTemplateManager({
      mode: 'save',
      currentValues: this.currentValues(),
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
