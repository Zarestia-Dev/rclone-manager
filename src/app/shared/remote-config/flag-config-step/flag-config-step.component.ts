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

  isType(type: FlagType | FlagType[]): boolean {
    const current = this.flagType();
    return Array.isArray(type) ? type.includes(current) : current === type;
  }
}
