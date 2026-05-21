import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  computed,
  output,
  signal,
} from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TitleCasePipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { FlagType, RcConfigOption } from '@app/types';
import { JsonEditorComponent, SettingControlComponent } from 'src/app/shared/components';
import { OperationConfigComponent } from 'src/app/shared/remote-config/app-operation-config/app-operation-config.component';
import { IconService, matchesConfigSearch, RemoteConfigStateService } from '@app/services';

@Component({
  selector: 'app-flag-config-step',
  imports: [
    TitleCasePipe,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatButtonModule,
    MatTooltipModule,
    SettingControlComponent,
    OperationConfigComponent,
    JsonEditorComponent,
    TranslateModule,
  ],
  templateUrl: './flag-config-step.component.html',
  styleUrl: './flag-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlagConfigStepComponent {
  readonly iconService = inject(IconService);
  private readonly stateService = inject(RemoteConfigStateService, { optional: true });

  readonly form = input<FormGroup>();
  readonly flagType = input.required<FlagType>();
  readonly existingRemotes = input<string[]>();
  readonly currentRemoteName = input<string>();
  readonly isNewRemote = input<boolean>();
  readonly searchQuery = input<string>();
  readonly dynamicFlagFields = input<RcConfigOption[]>();
  readonly mountTypes = input<string[]>();
  readonly getControlKey = input<(flagType: FlagType, field: RcConfigOption) => string>();
  readonly availableServeTypes = input<string[]>();
  readonly isLoadingServeFields = input<boolean>();
  readonly highlightedFields = input<Set<string>>();

  readonly serveTypeChange = output<string>();
  readonly showJsonMode = signal(false);

  readonly activeForm = computed(() => this.form() ?? this.stateService?.remoteConfigForm);
  readonly activeExistingRemotes = computed(
    () => this.existingRemotes() ?? this.stateService?.existingRemotes() ?? []
  );
  readonly activeCurrentRemoteName = computed(
    () => this.currentRemoteName() ?? this.stateService?.currentRemoteName() ?? ''
  );
  readonly activeIsNewRemote = computed(
    () => this.isNewRemote() ?? !this.stateService?.editTarget()
  );
  readonly activeSearchQuery = computed(
    () => this.searchQuery() ?? this.stateService?.searchQuery() ?? ''
  );

  readonly configGroup = computed(
    () => this.activeForm()?.get(`${this.flagType()}Config`) as FormGroup
  );
  readonly optionsGroup = computed(() => this.configGroup()?.get('options') as FormGroup);

  readonly isServe = computed(() => this.flagType() === 'serve');
  readonly isMount = computed(() => this.flagType() === 'mount');
  readonly showOperationConfig = computed(
    () => !['vfs', 'filter', 'backend'].includes(this.flagType())
  );
  readonly editorKeyPrefix = computed(() => (this.isServe() ? '' : `${this.flagType()}---`));

  readonly operationDescriptionKey = computed(() =>
    this.isServe()
      ? 'wizards.remoteConfig.serveDescription'
      : 'wizards.remoteConfig.operationDescription'
  );

  // Directly track form state using modern runtime extraction strategy
  readonly serveTypeValue = computed(() => {
    const group = this.configGroup();
    return group ? (group.get('type')?.value ?? '') : '';
  });

  readonly activeDynamicFlagFields = computed(() => {
    if (this.dynamicFlagFields() !== undefined) return this.dynamicFlagFields()!;
    if (!this.stateService) return [];
    return this.isServe()
      ? this.stateService.dynamicServeFields()
      : (this.stateService.dynamicFlagFields()[this.flagType()] ?? []);
  });

  readonly activeHighlightedFields = computed(
    () =>
      this.highlightedFields() ??
      this.stateService?.highlightedFieldsForActiveProfiles() ??
      new Set<string>()
  );
  readonly activeMountTypes = computed(
    () => this.mountTypes() ?? this.stateService?.mountTypes() ?? []
  );
  readonly activeAvailableServeTypes = computed(
    () => this.availableServeTypes() ?? this.stateService?.availableServeTypes() ?? []
  );
  readonly activeIsLoadingServeFields = computed(
    () => this.isLoadingServeFields() ?? this.stateService?.isLoadingServeFields() ?? false
  );

  readonly dynamicFieldBindings = computed(() => {
    const buildKey = this.getControlKey() ?? this.stateService?.getUniqueControlKey;
    if (!buildKey) return [];

    const flagType = this.flagType();
    const query = this.activeSearchQuery();
    const fields = query
      ? this.activeDynamicFlagFields().filter(field => matchesConfigSearch(field, query))
      : this.activeDynamicFlagFields();

    return fields.map(field => ({
      field,
      controlKey: buildKey(flagType, field),
      trackKey: field.FieldName ?? field.Name ?? '',
    }));
  });

  toggleJsonMode(): void {
    this.showJsonMode.update(v => !v);
  }

  onServeTypeSelected(type: string): void {
    if (this.stateService) void this.stateService.onServeTypeChange(type);
    this.serveTypeChange.emit(type);
  }
}
