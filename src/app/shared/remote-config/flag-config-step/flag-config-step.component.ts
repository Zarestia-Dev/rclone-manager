import {
  Component,
  ChangeDetectionStrategy,
  inject,
  input,
  computed,
  output,
  signal,
  effect,
} from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { FlagType, RcConfigOption } from '@app/types';
import { JsonEditorComponent } from 'src/app/shared/components/json-editor/json-editor.component';
import { SettingControlComponent } from 'src/app/shared/components/setting-control/setting-control.component';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { IconService } from 'src/app/services/ui/icon.service';
import { ConfigSearchService } from 'src/app/services/remote/config-search.service';

import { UiStateService } from 'src/app/services/ui/state/ui-state.service';

import { ConfigFormSkeletonComponent } from 'src/app/shared/remote-config/config-form-skeleton/config-form-skeleton.component';

@Component({
  selector: 'app-flag-config-step',
  imports: [
    ConfigFormSkeletonComponent,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatIconModule,
    MatButtonModule,
    SettingControlComponent,
    JsonEditorComponent,
    TranslatePipe,
    AlertBannerComponent,
  ],
  templateUrl: './flag-config-step.component.html',
  styleUrl: './flag-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlagConfigStepComponent {
  readonly iconService = inject(IconService);
  private readonly uiStateService = inject(UiStateService);
  private readonly configSearch = inject(ConfigSearchService);

  readonly form = input.required<FormGroup>();
  readonly flagType = input.required<FlagType>();
  readonly existingRemotes = input<string[]>([]);
  readonly currentRemoteName = input<string>('');
  readonly searchQuery = input<string>('');
  readonly dynamicFlagFields = input<RcConfigOption[]>([]);
  readonly isLoadingServeFields = input<boolean>(false);
  readonly isLoading = input(false);
  readonly isInvalid = input(false);
  readonly highlightedFields = input<Set<string>>(new Set());

  readonly serveTypeChange = output<string>();
  readonly showJsonMode = this.uiStateService.showJsonMode;

  readonly configGroup = computed(() => this.form().get(`${this.flagType()}Config`) as FormGroup);
  readonly optionsGroup = computed(() => this.configGroup()?.get('options') as FormGroup);

  readonly isServe = computed(() => this.flagType() === 'serve');
  readonly isMount = computed(() => this.flagType() === 'mount');

  readonly serveTypeValue = signal('');
  readonly isAllowOtherEnabled = signal(false);

  readonly dynamicFieldBindings = computed(() => {
    const query = this.searchQuery();
    const fields = query
      ? this.dynamicFlagFields().filter(field => this.configSearch.matches(field, query))
      : this.dynamicFlagFields();

    return fields.map(field => ({
      field,
      controlKey: field.Name || field.FieldName,
      trackKey: field.FieldName ?? field.Name ?? '',
    }));
  });

  constructor() {
    effect(onCleanup => {
      const group = this.configGroup();
      const typeCtrl = group?.get('options.type');
      if (!typeCtrl) return;

      this.serveTypeValue.set((typeCtrl.value as string) || '');
      const sub = typeCtrl.valueChanges.subscribe(val => this.serveTypeValue.set(val || ''));
      onCleanup(() => sub.unsubscribe());
    });

    effect(() => {
      const type = this.serveTypeValue();
      if (this.isServe()) {
        this.serveTypeChange.emit(type || 'http');
      }
    });

    effect(onCleanup => {
      const options = this.optionsGroup();
      if (!options) {
        this.isAllowOtherEnabled.set(false);
        return;
      }

      const checkValue = (): void => {
        const allowOtherVal =
          options.get('AllowOther')?.value ||
          options.get('allow_other')?.value ||
          options.get('allow-other')?.value;
        this.isAllowOtherEnabled.set(!!allowOtherVal);
      };

      checkValue();

      const sub = options.valueChanges.subscribe(() => checkValue());
      onCleanup(() => sub.unsubscribe());
    });
  }

  toggleJsonMode(): void {
    this.uiStateService.toggleShowJsonMode();
  }
}
