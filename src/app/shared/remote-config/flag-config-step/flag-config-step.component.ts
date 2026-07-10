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
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';
import { FlagType, RcConfigOption } from '@app/types';
import { JsonEditorComponent } from 'src/app/shared/components/json-editor/json-editor.component';
import { SettingControlComponent } from 'src/app/shared/components/setting-control/setting-control.component';
import { OperationConfigComponent } from 'src/app/shared/remote-config/app-operation-config/app-operation-config.component';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { IconService } from 'src/app/services/ui/icon.service';
import {
  matchesConfigSearch,
  getControlKey,
} from 'src/app/services/remote/utils/remote-config.utils';
import { RemoteConfigStateService } from 'src/app/services/remote/remote-config-state.service';

@Component({
  selector: 'app-flag-config-step',
  imports: [
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
    TranslatePipe,
    AlertBannerComponent,
  ],
  templateUrl: './flag-config-step.component.html',
  styleUrl: './flag-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FlagConfigStepComponent {
  readonly iconService = inject(IconService);
  readonly state = inject(RemoteConfigStateService);

  readonly form = input.required<FormGroup>();
  readonly flagType = input.required<FlagType>();
  readonly existingRemotes = input<string[]>([]);
  readonly currentRemoteName = input<string>('');
  readonly isNewRemote = input<boolean>(true);
  readonly searchQuery = input<string>('');
  readonly dynamicFlagFields = input<RcConfigOption[]>([]);
  readonly isLoadingServeFields = input<boolean>(false);
  readonly highlightedFields = input<Set<string>>(new Set());

  readonly serveTypeChange = output<string>();
  readonly showJsonMode = signal(false);

  readonly configGroup = computed(() => this.form().get(`${this.flagType()}Config`) as FormGroup);
  readonly optionsGroup = computed(() => this.configGroup()?.get('options') as FormGroup);

  readonly isServe = computed(() => this.flagType() === 'serve');
  readonly isMount = computed(() => this.flagType() === 'mount');
  readonly showOperationConfig = computed(
    () => !['vfs', 'filter', 'backend'].includes(this.flagType())
  );

  readonly operationDescriptionKey = computed(() =>
    this.isServe()
      ? 'wizards.remoteConfig.serveDescription'
      : 'wizards.remoteConfig.operationDescription'
  );

  readonly serveTypeValue = signal('');
  readonly isAllowOtherEnabled = signal(false);

  readonly dynamicFieldBindings = computed(() => {
    const query = this.searchQuery();
    const fields = query
      ? this.dynamicFlagFields().filter(field => matchesConfigSearch(field, query))
      : this.dynamicFlagFields();

    return fields.map(field => ({
      field,
      controlKey: getControlKey(field, this.flagType()),
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
    this.showJsonMode.update(v => !v);
  }
}
