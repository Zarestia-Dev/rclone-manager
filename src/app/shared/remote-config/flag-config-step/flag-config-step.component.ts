import { Component, ChangeDetectionStrategy, inject, input, computed, output } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { FlagType, RcConfigOption } from '@app/types';
import { SettingControlComponent } from 'src/app/shared/components';
import { OperationConfigComponent } from 'src/app/shared/remote-config/app-operation-config/app-operation-config.component';
import { IconService } from '@app/services';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-flag-config-step',
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonModule,
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

  // Signal Inputs
  form = input.required<FormGroup>();
  flagType = input.required<FlagType>();
  existingRemotes = input<string[]>([]);
  currentRemoteName = input.required<string>();
  isNewRemote = input(false);
  searchQuery = input('');
  dynamicFlagFields = input<RcConfigOption[]>([]);
  mountTypes = input<string[]>([]);
  getControlKey = input.required<(flagType: FlagType, field: RcConfigOption) => string>();

  // Serve-specific inputs
  availableServeTypes = input<string[]>([]);
  selectedServeType = input('http');
  isLoadingServeFields = input(false);

  serveTypeChange = output<string>();

  onServeTypeChange(type: string): void {
    this.serveTypeChange.emit(type);
  }

  configGroup = computed(() => this.form().get(`${this.flagType()}Config`) as FormGroup);

  isServe = computed(() => this.flagType() === 'serve');
  isMount = computed(() => this.flagType() === 'mount');
  showOperationConfig = computed(() => !['vfs', 'filter', 'backend'].includes(this.flagType()));
  operationDescriptionKey = computed(() =>
    this.isServe()
      ? 'wizards.remoteConfig.serveDescription'
      : 'wizards.remoteConfig.operationDescription'
  );
  operationExistingRemotes = computed(() => (this.isServe() ? [] : this.existingRemotes()));
  operationIsNewRemote = computed(() => (this.isServe() ? false : this.isNewRemote()));

  serveTypeValue = computed(() => {
    const controlValue = this.configGroup()?.get('type')?.value;
    return typeof controlValue === 'string' && controlValue
      ? controlValue
      : this.selectedServeType();
  });

  filteredDynamicFlagFields = computed(() => {
    const query = this.searchQuery()?.toLowerCase().trim();
    if (!query) {
      return this.dynamicFlagFields();
    }

    return this.dynamicFlagFields().filter(field => {
      const nameMatch = field.Name?.toLowerCase().includes(query);
      const fieldNameMatch = field.FieldName?.toLowerCase().includes(query);
      const helpMatch = field.Help?.toLowerCase().includes(query);
      return nameMatch || fieldNameMatch || helpMatch;
    });
  });

  dynamicFieldBindings = computed(() => {
    const controlKeyBuilder = this.getControlKey();
    const currentFlagType = this.flagType();

    return this.filteredDynamicFlagFields().map(field => {
      const controlKey = controlKeyBuilder(currentFlagType, field);
      const trackKey = field.FieldName || field.Name || controlKey;

      return {
        field,
        controlKey,
        trackKey,
      };
    });
  });
}
