import {
  Component,
  effect,
  input,
  output,
  signal,
  computed,
  untracked,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { toSignal, toObservable } from '@angular/core/rxjs-interop';
import { startWith, switchMap } from 'rxjs';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { RcConfigOption, RemoteType, RemoteConfigStepVisibility } from '@app/types';
import { IconService, matchesConfigSearch } from '@app/services';
import { JsonEditorComponent, SettingControlComponent } from 'src/app/shared/components';

@Component({
  selector: 'app-remote-config-step',
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    MatAutocompleteModule,
    MatButtonModule,
    MatTooltipModule,
    SettingControlComponent,
    JsonEditorComponent,
    TranslateModule,
    MatIcon,
  ],
  templateUrl: './remote-config-step.component.html',
  styleUrl: './remote-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteConfigStepComponent {
  readonly iconService = inject(IconService);

  // --- Signal Inputs ---
  readonly form = input.required<FormGroup>();
  readonly remoteFields = input<RcConfigOption[]>([]);
  readonly isLoading = input(false);
  readonly existingRemotes = input<string[]>([]);
  readonly isTypeLocked = input(false);
  readonly useInteractiveMode = input(false);
  readonly remoteTypes = input<RemoteType[]>([]);
  readonly visibility = input<RemoteConfigStepVisibility>({});
  readonly showAdvancedOptions = input(false);
  readonly searchQuery = input('');

  // --- Signal Outputs ---
  readonly remoteTypeChanged = output<void>();
  readonly interactiveModeToggled = output<boolean>();
  readonly advancedOptionsToggled = output<boolean>();
  readonly fieldChanged = output<{ fieldName: string; isChanged: boolean }>();

  // --- Visibility Computed ---
  readonly showTypeField = computed(() => this.visibility().type ?? true);
  readonly showAdvancedToggle = computed(() => this.visibility().advanced ?? true);
  readonly showNameField = computed(() => this.visibility().name ?? true);
  readonly showInteractiveToggle = computed(() => this.visibility().interactive ?? true);

  // --- Local Form Controls ---
  readonly remoteSearchCtrl = new FormControl('');
  readonly providerSearchCtrl = new FormControl('');

  readonly remoteTypeValue = toSignal(
    toObservable(this.form).pipe(
      switchMap(f =>
        (f.get('type')?.valueChanges ?? f.valueChanges).pipe(startWith(f.get('type')?.value ?? ''))
      )
    ),
    { initialValue: '' }
  );

  // --- Local Signals ---
  readonly selectedProvider = signal<string | undefined>(undefined);

  private readonly remoteSearchTerm = toSignal(this.remoteSearchCtrl.valueChanges, {
    initialValue: this.remoteSearchCtrl.value ?? '',
  });
  private readonly providerSearchTerm = toSignal(this.providerSearchCtrl.valueChanges, {
    initialValue: this.providerSearchCtrl.value ?? '',
  });

  constructor() {
    // Sync provider control value → selectedProvider signal
    effect(onCleanup => {
      const fieldDef = this.providerField();
      if (!fieldDef) return;

      const control = this.form().get(fieldDef.Name);
      if (!control) return;

      const sub = control.valueChanges.pipe(startWith(control.value)).subscribe(val => {
        const oldVal = untracked(this.selectedProvider);
        if (val === oldVal) return;

        untracked(() => {
          this.selectedProvider.set(val);
          if (oldVal) {
            this.clearProviderDependentFields(this.remoteFields(), this.form(), val);
          }
          const displayVal = this.displayProvider(val);
          if (displayVal !== this.providerSearchCtrl.value) {
            this.providerSearchCtrl.setValue(displayVal, { emitEvent: false });
          }
        });
      });

      onCleanup(() => sub.unsubscribe());
    });

    // Sync type control value → remote search control
    effect(onCleanup => {
      const typeControl = this.form().get('type');
      if (!typeControl) return;

      const sub = typeControl.valueChanges.pipe(startWith(typeControl.value)).subscribe(val => {
        this.remoteSearchCtrl.setValue(this.displayRemote(val), { emitEvent: false });
      });

      onCleanup(() => sub.unsubscribe());
    });

    // Lock/unlock remote type search control
    effect(() => {
      if (this.isTypeLocked()) {
        this.remoteSearchCtrl.disable({ emitEvent: false });
      } else {
        this.remoteSearchCtrl.enable({ emitEvent: false });
      }
    });
  }

  // --- Computed State ---

  /** Filtered list of remotes based on search term */
  readonly filteredRemotes = computed(() => {
    const types = this.remoteTypes();
    const term = (this.remoteSearchTerm() || '').toLowerCase();
    return types.filter(
      remote =>
        remote.label.toLowerCase().includes(term) || remote.value.toLowerCase().includes(term)
    );
  });

  /**
   * The identified provider field — first checks for a field named 'provider' with examples,
   * then falls back to any field with examples where provider-scoped fields exist.
   */
  readonly providerField = computed(() => {
    const fields = this.remoteFields();
    const byName = fields.find(
      field => field.Name === 'provider' && field.Examples && field.Examples.length > 0
    );
    if (byName) return byName;

    const hasProviderScoped = fields.some(field => field.Provider);
    if (!hasProviderScoped) return null;

    return fields.find(field => field.Examples && field.Examples.length > 0) ?? null;
  });

  /** Filtered provider examples */
  readonly filteredProviders = computed(() => {
    const field = this.providerField();
    if (!field?.Examples) return [];

    const term = (this.providerSearchTerm() || '').toLowerCase();
    return field.Examples.filter(
      opt =>
        (opt.Value && opt.Value.toLowerCase().includes(term)) ||
        (opt.Help && opt.Help.toLowerCase().includes(term))
    );
  });

  readonly basicFields = computed(() => this.getFieldsByAdvanced(false));
  readonly advancedFields = computed(() => this.getFieldsByAdvanced(true));
  readonly providerReady = computed(() => !this.providerField() || !!this.selectedProvider());

  // --- Logic Helpers ---

  private matchesProviderRule(rule: string | undefined, provider?: string): boolean {
    if (!rule) return true;
    if (!provider) return false;
    const isNegated = rule.startsWith('!');
    const parts = (isNegated ? rule.substring(1) : rule).split(',').map(p => p.trim());
    return isNegated ? !parts.includes(provider) : parts.includes(provider);
  }

  private getFilteredField(field: RcConfigOption, provider?: string): RcConfigOption {
    if (!field.Examples || field.Examples.length === 0 || !provider) return field;
    const filteredExamples = field.Examples.filter(ex =>
      this.matchesProviderRule(ex.Provider, provider)
    );
    return { ...field, Examples: filteredExamples };
  }

  private matchesSearch(field: RcConfigOption, query: string): boolean {
    return matchesConfigSearch(field, query);
  }

  private getFieldsByAdvanced(isAdvanced: boolean): RcConfigOption[] {
    const providerName = this.providerField()?.Name;
    const currentProvider = this.selectedProvider();
    const query = this.searchQuery().trim();

    return this.remoteFields()
      .filter(f => !!f.Advanced === isAdvanced)
      .filter(f => f.Name !== providerName)
      .filter(f => this.matchesProviderRule(f.Provider, currentProvider))
      .map(f => this.getFilteredField(f, currentProvider))
      .filter(f => this.matchesSearch(f, query));
  }

  private clearProviderDependentFields(
    fields: RcConfigOption[],
    form: FormGroup,
    newProvider: string
  ): void {
    fields.forEach(field => {
      if (field.Provider && !this.matchesProviderRule(field.Provider, newProvider)) {
        form.get(field.Name)?.setValue(null);
      }
      if (field.Examples && field.Examples.length > 0) {
        const control = form.get(field.Name);
        const currentValue = control?.value;
        if (currentValue && !this.isValueValidForProvider(field, currentValue, newProvider)) {
          control?.setValue('');
        }
      }
    });
  }

  private isValueValidForProvider(field: RcConfigOption, value: string, provider: string): boolean {
    const match = field.Examples?.find(ex => ex.Value === value);
    return !(match && !this.matchesProviderRule(match.Provider, provider));
  }

  // --- Template Bindings ---

  onTypeSelected(value: string): void {
    this.form().get('type')?.setValue(value);
    this.generateRemoteName(value);
    this.remoteTypeChanged.emit();
  }

  private generateRemoteName(remoteType: string): void {
    const nameControl = this.form().get('name');
    if (!nameControl || (nameControl.value && nameControl.dirty)) return;

    const baseName = remoteType.replace(/\s+/g, '');
    const existingNames = new Set(this.existingRemotes());
    let newName = baseName;
    let counter = 1;

    while (existingNames.has(newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    nameControl.setValue(newName, { emitEvent: true });
    nameControl.updateValueAndValidity({ emitEvent: false });

    if (nameControl.invalid) {
      nameControl.markAsTouched();
    }
  }

  readonly displayRemote = (remoteValue: string): string => {
    if (!remoteValue) return '';
    return this.remoteTypes().find(t => t.value === remoteValue)?.label || remoteValue;
  };

  readonly displayProvider = (value: string): string => {
    const field = this.providerField();
    if (!field?.Examples) return value;
    return field.Examples.find(o => o.Value === value)?.Help ?? value;
  };

  toggleAdvancedOptions(): void {
    this.advancedOptionsToggled.emit(!this.showAdvancedOptions());
  }

  toggleInteractiveMode(): void {
    this.interactiveModeToggled.emit(!this.useInteractiveMode());
  }

  onProviderSelected(value: string): void {
    const field = this.providerField();
    if (field) {
      this.form().get(field.Name)?.setValue(value);
    }
  }

  onFieldChanged(fieldName: string, isChanged: boolean): void {
    this.fieldChanged.emit({ fieldName, isChanged });
  }

  // JSON editor toggle — switches both basic and advanced fields to a single JSON view.
  readonly showJsonMode = signal(false);

  toggleJsonMode(): void {
    this.showJsonMode.update(v => !v);
  }

  // The JSON editor operates on the form directly (remote config fields are top-level
  // controls on `form()`, not nested under an 'options' sub-group).
  get allRemoteFields(): RcConfigOption[] {
    return [...this.basicFields(), ...this.advancedFields()];
  }
}
