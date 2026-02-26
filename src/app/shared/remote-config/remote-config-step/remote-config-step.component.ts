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
import { toSignal } from '@angular/core/rxjs-interop';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { RcConfigOption, RemoteType } from '@app/types';
import { SettingControlComponent } from 'src/app/shared/components';
import { startWith } from 'rxjs/operators';
import { TranslateModule } from '@ngx-translate/core';
import { MatIcon } from '@angular/material/icon';
import { IconService } from '@app/services';

@Component({
  selector: 'app-remote-config-step',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    MatAutocompleteModule,
    SettingControlComponent,
    ScrollingModule,
    TranslateModule,
    MatIcon,
  ],
  templateUrl: './remote-config-step.component.html',
  styleUrl: './remote-config-step.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteConfigStepComponent {
  // --- Signal Inputs ---
  form = input.required<FormGroup>();
  remoteFields = input<RcConfigOption[]>([]);
  isLoading = input(false);
  existingRemotes = input<string[]>([]);
  isTypeLocked = input(false);
  useInteractiveMode = input(false);
  remoteTypes = input<RemoteType[]>([]);
  showAdvancedToggle = input(true);
  searchQuery = input('');

  // --- Signal Outputs ---
  remoteTypeChanged = output<void>();
  interactiveModeToggled = output<boolean>();
  advancedOptionsToggled = output<boolean>();
  fieldChanged = output<{ fieldName: string; isChanged: boolean }>();

  // --- Local Form Controls ---
  remoteSearchCtrl = new FormControl('');
  providerSearchCtrl = new FormControl('');

  // --- Local Signals ---
  showAdvancedOptions = input(false);
  selectedProvider = signal<string | undefined>(undefined);

  // Convert FormControls to Signals for use in computed
  private remoteSearchTerm = toSignal(
    this.remoteSearchCtrl.valueChanges.pipe(startWith(this.remoteSearchCtrl.value)),
    {
      initialValue: this.remoteSearchCtrl.value || '',
    }
  );
  private providerSearchTerm = toSignal(
    this.providerSearchCtrl.valueChanges.pipe(startWith(this.providerSearchCtrl.value)),
    {
      initialValue: this.providerSearchCtrl.value || '',
    }
  );

  readonly iconService = inject(IconService);

  constructor() {
    // Sync Provider control value -> Signal mapping
    effect(onCleanup => {
      const fieldDef = this.providerField();
      if (!fieldDef) return;

      const control = this.form().get(fieldDef.Name);
      if (!control) return;

      // Manually subscribe since the control instance can change
      const sub = control.valueChanges.pipe(startWith(control.value)).subscribe(val => {
        const oldVal = untracked(this.selectedProvider);
        if (val !== oldVal) {
          untracked(() => {
            this.selectedProvider.set(val);
            if (oldVal) {
              this.clearProviderDependentFields(this.remoteFields(), this.form(), val);
            }
            // Sync search control
            if (val !== this.providerSearchCtrl.value) {
              this.providerSearchCtrl.setValue(val, { emitEvent: false });
            }
          });
        }
      });

      onCleanup(() => sub.unsubscribe());
    });

    // Sync Type control value -> local search control
    effect(onCleanup => {
      const typeControl = this.form().get('type');
      if (!typeControl) return;

      const sub = typeControl.valueChanges.pipe(startWith(typeControl.value)).subscribe(val => {
        this.remoteSearchCtrl.setValue(this.displayRemote(val), {
          emitEvent: false,
        });
      });

      onCleanup(() => sub.unsubscribe());

      // Sync disabled state
      const isLocked = this.isTypeLocked();
      untracked(() => {
        if (isLocked) {
          this.remoteSearchCtrl.disable({ emitEvent: false });
        } else {
          this.remoteSearchCtrl.enable({ emitEvent: false });
        }
      });
    });
  }

  // --- Computed State ---

  /** Map for O(1) label lookups */
  private remoteTypeMap = computed(() => {
    return new Map(this.remoteTypes().map(t => [t.value, t]));
  });

  /** Filtered list of remotes based on search term */
  filteredRemotes = computed(() => {
    const types = this.remoteTypes();
    const term = (this.remoteSearchTerm() || '').toLowerCase();
    return types.filter(
      remote =>
        remote.label.toLowerCase().includes(term) || remote.value.toLowerCase().includes(term)
    );
  });

  /** The identified provider field configuration */
  providerField = computed(() => {
    const fields = this.remoteFields();
    let f = fields.find(f => f.Name === 'provider' && f.Examples && f.Examples.length > 0);
    if (!f) {
      f = fields.find(
        x => x.Examples && x.Examples.length > 0 && fields.some(other => other.Provider)
      );
    }
    return f || null;
  });

  /** Filtered provider examples */
  filteredProviders = computed(() => {
    const field = this.providerField();
    if (!field || !field.Examples) return [];

    const term = (this.providerSearchTerm() || '').toLowerCase();
    return field.Examples.filter(
      opt =>
        (opt.Value && opt.Value.toLowerCase().includes(term)) ||
        (opt.Help && opt.Help.toLowerCase().includes(term))
    );
  });

  basicFields = computed(() => {
    const fields = this.remoteFields();
    const providerName = this.providerField()?.Name;
    const currentProvider = this.selectedProvider();
    const query = this.searchQuery().toLowerCase().trim();

    let filtered = fields
      .filter(f => !f.Advanced)
      .filter(f => f.Name !== providerName) // Don't show provider field here
      .filter(f => this.shouldShowField(f, currentProvider))
      .map(f => this.getFilteredField(f, currentProvider));

    // Apply search filter
    if (query) {
      filtered = filtered.filter(field => {
        const nameMatch = field.Name?.toLowerCase().includes(query);
        const fieldNameMatch = field.FieldName?.toLowerCase().includes(query);
        const helpMatch = field.Help?.toLowerCase().includes(query);
        return nameMatch || fieldNameMatch || helpMatch;
      });
    }

    return filtered as RcConfigOption[];
  });

  /** Advanced config fields, filtered by selected provider and search query */
  advancedFields = computed(() => {
    const fields = this.remoteFields();
    const providerName = this.providerField()?.Name;
    const currentProvider = this.selectedProvider();
    const query = this.searchQuery().toLowerCase().trim();

    let filtered = fields
      .filter(f => f.Advanced)
      .filter(f => f.Name !== providerName)
      .filter(f => this.shouldShowField(f, currentProvider))
      .map(f => this.getFilteredField(f, currentProvider));

    // Apply search filter
    if (query) {
      filtered = filtered.filter(field => {
        const nameMatch = field.Name?.toLowerCase().includes(query);
        const fieldNameMatch = field.FieldName?.toLowerCase().includes(query);
        const helpMatch = field.Help?.toLowerCase().includes(query);
        return nameMatch || fieldNameMatch || helpMatch;
      });
    }

    return filtered as RcConfigOption[];
  });

  /** Virtual Scroll Data Source */
  formFields = computed(() => {
    const fields = [];
    fields.push({ type: 'basic-info' });
    fields.push({ type: 'config-toggles' });

    if (this.providerField()) {
      fields.push({ type: 'provider-field' });
    }

    const hasBasic = this.basicFields().length > 0;
    // Show fields if no provider concept exists OR if a provider is selected
    const providerReady = !this.providerField() || this.selectedProvider();

    if (hasBasic && providerReady) {
      fields.push({ type: 'basic-fields' });
    }

    if (this.showAdvancedOptions() && this.advancedFields().length > 0 && providerReady) {
      fields.push({ type: 'advanced-section' });
    }

    return fields;
  });

  // --- Logic Helpers ---

  private shouldShowField(field: RcConfigOption, provider?: string): boolean {
    const providerRule = field.Provider;
    if (!providerRule) return true;
    if (!provider) return false;

    const isNegated = providerRule.startsWith('!');
    const cleanRule = isNegated ? providerRule.substring(1) : providerRule;
    const parts = cleanRule.split(',').map(p => p.trim());

    if (isNegated) {
      return !parts.includes(provider);
    } else {
      return parts.includes(provider);
    }
  }

  private getFilteredField(field: RcConfigOption, provider?: string): RcConfigOption {
    if (!field.Examples || field.Examples.length === 0 || !provider) {
      return field;
    }
    // Filter examples based on provider rule
    const filteredExamples = field.Examples.filter(ex =>
      this.isProviderMatch(ex.Provider, provider)
    );
    return { ...field, Examples: filteredExamples };
  }

  private isProviderMatch(rule: string | undefined, provider: string): boolean {
    if (!rule) return true;
    const isNegated = rule.startsWith('!');
    const cleanRule = isNegated ? rule.substring(1) : rule;
    const parts = cleanRule.split(',').map(p => p.trim());

    return isNegated ? !parts.includes(provider) : parts.includes(provider);
  }

  private clearProviderDependentFields(
    fields: RcConfigOption[],
    form: FormGroup,
    newProvider: string
  ): void {
    fields.forEach(field => {
      // If a field has a specific Provider rule, checks if it is still valid
      if (field.Provider) {
        const isVisible = this.shouldShowField(field, newProvider);
        if (!isVisible) {
          // Field is hidden now -> reset it
          form.get(field.Name)?.setValue(null);
        }
      }

      // If a field is shared (like 'endpoint') but the Examples list changed
      if (field.Examples && field.Examples.length > 0) {
        const control = form.get(field.Name);
        const currentValue = control?.value;

        // If the current value was one of the OLD examples, we should probably clear it
        // so the user doesn't accidentally send an Alibaba endpoint to AWS
        // (Optional: strict check logic could go here)
        if (currentValue && !this.isValueValidForProvider(field, currentValue, newProvider)) {
          control?.setValue(''); // Reset to empty so they pick a new one
        }
      }
    });
  }

  private isValueValidForProvider(field: RcConfigOption, value: string, provider: string): boolean {
    // If the value matches an Example that is NOT allowed for this provider, return false
    const match = field.Examples?.find(ex => ex.Value === value);
    if (match && match.Provider && !this.isProviderMatch(match.Provider, provider)) {
      return false;
    }
    return true;
  }

  // --- Template Bindings ---

  trackByField(index: number, field: { type: string }): string {
    return `${field.type}-${index}`;
  }

  onTypeSelected(value: string): void {
    this.form().get('type')?.setValue(value);
    this.generateRemoteName(value);
    this.remoteTypeChanged.emit();
  }

  private generateRemoteName(remoteType: string): void {
    const nameControl = this.form().get('name');
    // Only auto-generate if the field is empty or hasn't been manually edited
    if (!nameControl || (nameControl.value && nameControl.dirty)) {
      return;
    }

    const baseName = remoteType.replace(/\s+/g, '');
    const existingNames = this.existingRemotes();
    let newName = baseName;
    let counter = 1;

    while (existingNames.includes(newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    nameControl.setValue(newName, { emitEvent: true });
  }

  displayRemote = (remoteValue: string): string => {
    if (!remoteValue) return '';
    return this.remoteTypes().find(t => t.value === remoteValue)?.label || remoteValue;
  };

  displayProvider = (value: string): string => {
    const field = this.providerField();
    if (!field?.Examples) return value;
    const option = field.Examples.find(o => o.Value === value);
    return option ? option.Help : value;
  };

  toggleAdvancedOptions(): void {
    const newValue = !this.showAdvancedOptions();
    this.advancedOptionsToggled.emit(newValue);
  }

  toggleInteractiveMode(): void {
    const newValue = !this.useInteractiveMode();
    this.interactiveModeToggled.emit(newValue);
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
}
