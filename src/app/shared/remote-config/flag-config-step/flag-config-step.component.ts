import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  computed,
  output,
  Signal,
} from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TitleCasePipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { switchMap, startWith, of } from 'rxjs';

import { FlagType, RcConfigOption } from '@app/types';
import { SettingControlComponent } from 'src/app/shared/components';
import { OperationConfigComponent } from 'src/app/shared/remote-config/app-operation-config/app-operation-config.component';
import { IconService, matchesConfigSearch } from '@app/services';

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

  private static readonly EMPTY_GROUP = new FormGroup({});

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
  configGroup = computed(
    () =>
      (this.form().get(`${this.flagType()}Config`) as FormGroup | null) ??
      FlagConfigStepComponent.EMPTY_GROUP
  );

  isServe = computed(() => this.flagType() === 'serve');
  isMount = computed(() => this.flagType() === 'mount');

  showOperationConfig = computed(() => !['vfs', 'filter', 'backend'].includes(this.flagType()));

  operationDescriptionKey = computed(() =>
    this.isServe()
      ? 'wizards.remoteConfig.serveDescription'
      : 'wizards.remoteConfig.operationDescription'
  );

  private readonly configGroupAny = this.configGroup as unknown as Signal<FormGroup<any>>;

  readonly serveTypeValue = toSignal(
    toObservable(this.configGroupAny).pipe(
      switchMap(group => {
        const ctrl = group.get('type');
        if (!ctrl) return of('');
        return ctrl.valueChanges.pipe(startWith((ctrl.value as string) ?? ''));
      })
    ),
    { initialValue: '' }
  );

  filteredDynamicFlagFields = computed(() => {
    const query = this.searchQuery();
    if (!query) return this.dynamicFlagFields();

    return this.dynamicFlagFields().filter(field => matchesConfigSearch(field, query));
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
