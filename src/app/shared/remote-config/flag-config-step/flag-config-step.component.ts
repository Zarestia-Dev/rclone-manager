import { Component, ChangeDetectionStrategy, inject, input, computed, output } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TitleCasePipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';

import { FlagType, RcConfigOption } from '@app/types';
import { SettingControlComponent } from 'src/app/shared/components';
import { OperationConfigComponent } from 'src/app/shared/remote-config/app-operation-config/app-operation-config.component';
import { IconService } from '@app/services';

@Component({
  selector: 'app-flag-config-step',
  imports: [
    TitleCasePipe,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatIconModule,
    MatProgressSpinnerModule,
    SettingControlComponent,
    OperationConfigComponent,
    TranslateModule,
  ],
  templateUrl: './flag-config-step.component.html',
  styleUrl: './flag-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlagConfigStepComponent {
  readonly iconService = inject(IconService);

  // Inputs
  form = input.required<FormGroup>();
  flagType = input.required<FlagType>();
  existingRemotes = input<string[]>([]);
  currentRemoteName = input.required<string>();
  isNewRemote = input(false);
  searchQuery = input('');
  dynamicFlagFields = input<RcConfigOption[]>([]);
  mountTypes = input<string[]>([]);
  getControlKey = input.required<(flagType: FlagType, field: RcConfigOption) => string>();
  availableServeTypes = input<string[]>([]);
  isLoadingServeFields = input(false);

  serveTypeChange = output<string>();

  // Derived state
  configGroup = computed(() => this.form().get(`${this.flagType()}Config`) as FormGroup);

  isServe = computed(() => this.flagType() === 'serve');
  isMount = computed(() => this.flagType() === 'mount');

  showOperationConfig = computed(() => !['vfs', 'filter', 'backend'].includes(this.flagType()));

  operationDescriptionKey = computed(() =>
    this.isServe()
      ? 'wizards.remoteConfig.serveDescription'
      : 'wizards.remoteConfig.operationDescription'
  );

  serveTypeValue = computed(() => (this.configGroup()?.get('type')?.value as string) ?? '');

  filteredDynamicFlagFields = computed(() => {
    const query = this.searchQuery()?.toLowerCase().trim();
    if (!query) return this.dynamicFlagFields();

    return this.dynamicFlagFields().filter(
      field =>
        (field.Name?.toLowerCase().includes(query) ?? false) ||
        (field.FieldName?.toLowerCase().includes(query) ?? false) ||
        (field.Help?.toLowerCase().includes(query) ?? false)
    );
  });

  dynamicFieldBindings = computed(() => {
    const buildKey = this.getControlKey();
    const flagType = this.flagType();

    return this.filteredDynamicFlagFields()
      .map(field => ({
        field,
        controlKey: buildKey(flagType, field),
        trackKey: field.FieldName ?? field.Name ?? '',
      }))
      .filter(binding => !!binding.controlKey);
  });
}
