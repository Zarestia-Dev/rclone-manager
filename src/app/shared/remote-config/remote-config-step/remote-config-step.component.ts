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
import { MatChipsModule, MatChipInputEvent } from '@angular/material/chips';
import { MatSelectModule } from '@angular/material/select';
import { COMMA, ENTER } from '@angular/cdk/keycodes';
import { TranslateModule } from '@ngx-translate/core';
import {
  RcConfigOption,
  RemoteType,
  RemoteConfigStepVisibility,
  CommandOption,
  CommandOptionType,
  PREDEFINED_OPTIONS,
  PredefinedOption,
} from '@app/types';
import { IconService, matchesConfigSearch, RemoteManagementService } from '@app/services';
import { JsonEditorComponent, SettingControlComponent } from 'src/app/shared/components';

export const INITIAL_COMMAND_OPTIONS: CommandOption[] = [
  { id: 'default-obscure', key: 'obscure', type: 'boolean', value: true, managed: false },
];

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
    MatChipsModule,
    MatSelectModule,
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
  readonly remoteManagementService = inject(RemoteManagementService);
  readonly iconService = inject(IconService);

  readonly separatorKeysCodes = [ENTER, COMMA] as const;

  // ── Inputs ────────────────────────────────────────────────────────────────

  readonly form = input.required<FormGroup>();
  readonly remoteFields = input<RcConfigOption[]>([]);
  readonly isLoading = input(false);
  readonly existingRemotes = input<string[]>([]);
  readonly isTypeLocked = input(false);
  readonly remoteTypes = input<RemoteType[]>([]);
  readonly visibility = input<RemoteConfigStepVisibility>({});
  readonly showAdvancedOptions = input(false);
  readonly searchQuery = input('');
  readonly initialCommandOptions = input<CommandOption[]>();

  // ── Outputs ───────────────────────────────────────────────────────────────

  readonly remoteTypeChanged = output<void>();
  readonly advancedOptionsToggled = output<boolean>();
  readonly fieldChanged = output<{ fieldName: string; isChanged: boolean }>();
  readonly commandOptionsChanged = output<CommandOption[]>();

  // ── Visibility ────────────────────────────────────────────────────────────

  readonly showTypeField = computed(() => this.visibility().type ?? true);
  readonly showAdvancedToggle = computed(() => this.visibility().advanced ?? true);
  readonly showNameField = computed(() => this.visibility().name ?? true);

  // ── Local form controls ───────────────────────────────────────────────────

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

  private readonly remoteSearchTerm = toSignal(this.remoteSearchCtrl.valueChanges, {
    initialValue: this.remoteSearchCtrl.value ?? '',
  });

  private readonly providerSearchTerm = toSignal(this.providerSearchCtrl.valueChanges, {
    initialValue: this.providerSearchCtrl.value ?? '',
  });

  // ── Signals ───────────────────────────────────────────────────────────────

  readonly selectedProvider = signal<string | undefined>(undefined);
  readonly showJsonMode = signal(false);
  readonly showCommandOptions = signal(false);
  readonly commandOptions = signal<CommandOption[]>(INITIAL_COMMAND_OPTIONS);
  readonly newOptionKey = signal('');
  readonly newOptionType = signal<CommandOptionType>('boolean');

  readonly predefinedOptions = PREDEFINED_OPTIONS;

  // ── Computed ──────────────────────────────────────────────────────────────

  readonly filteredRemotes = computed(() => {
    const term = (this.remoteSearchTerm() ?? '').toLowerCase();
    return this.remoteTypes().filter(
      r => r.label.toLowerCase().includes(term) || r.value.toLowerCase().includes(term)
    );
  });

  readonly providerField = computed(() => {
    const fields = this.remoteFields();
    const byName = fields.find(f => f.Name === 'provider' && f.Examples?.length);
    if (byName) return byName;
    if (!fields.some(f => f.Provider)) return null;
    return fields.find(f => f.Examples?.length) ?? null;
  });

  readonly filteredProviders = computed(() => {
    const field = this.providerField();
    if (!field?.Examples) return [];
    const term = (this.providerSearchTerm() ?? '').toLowerCase();
    return field.Examples.filter(
      o => o.Value?.toLowerCase().includes(term) || o.Help?.toLowerCase().includes(term)
    );
  });

  readonly basicFields = computed(() => this.getFieldsByAdvanced(false));
  readonly advancedFields = computed(() => this.getFieldsByAdvanced(true));
  readonly allRemoteFields = computed(() => [...this.basicFields(), ...this.advancedFields()]);

  readonly providerReady = computed(
    () => !!this.remoteTypeValue() && (!this.providerField() || !!this.selectedProvider())
  );

  readonly availablePredefinedOptions = computed(() => {
    const active = new Set(this.commandOptions().map(o => o.key));
    return this.predefinedOptions.filter(p => !active.has(p.key));
  });

  // ── Effects ───────────────────────────────────────────────────────────────

  constructor() {
    effect(() => {
      this.commandOptionsChanged.emit(this.commandOptions());
    });

    effect(() => {
      const initial = this.initialCommandOptions();
      if (initial !== undefined) {
        untracked(() => {
          this.commandOptions.set(initial);
        });
      }
    });

    effect(onCleanup => {
      const typeControl = this.form().get('type');
      if (!typeControl) return;

      const sub = typeControl.valueChanges
        .pipe(startWith(typeControl.value))
        .subscribe(val =>
          this.remoteSearchCtrl.setValue(this.displayRemote(val), { emitEvent: false })
        );

      onCleanup(() => sub.unsubscribe());
    });

    effect(onCleanup => {
      const fieldDef = this.providerField();
      if (!fieldDef) return;

      const control = this.form().get(fieldDef.Name);
      if (!control) return;

      const sub = control.valueChanges.pipe(startWith(control.value)).subscribe(val => {
        const prev = untracked(this.selectedProvider);
        if (val === prev) return;

        untracked(() => {
          this.selectedProvider.set(val);
          if (prev) this.clearProviderDependentFields(this.remoteFields(), this.form(), val);

          const display = this.displayProvider(val);
          if (display !== this.providerSearchCtrl.value) {
            this.providerSearchCtrl.setValue(display, { emitEvent: false });
          }
        });
      });

      onCleanup(() => sub.unsubscribe());
    });

    effect(() => {
      const opts = { emitEvent: false } as const;
      if (this.isTypeLocked()) {
        this.remoteSearchCtrl.disable(opts);
      } else {
        this.remoteSearchCtrl.enable(opts);
      }
    });

    effect(() => {
      const isInteractive = this.remoteManagementService.isInteractiveRemote(
        this.remoteTypeValue()
      );

      untracked(() => {
        const opts = this.commandOptions();
        const hasNonInteractive = opts.some(o => o.key === 'nonInteractive');
        const hasManagedNonInteractive = opts.some(o => o.key === 'nonInteractive' && o.managed);

        if (isInteractive && !hasNonInteractive) {
          this.commandOptions.update(list => [
            ...list,
            {
              id: crypto.randomUUID(),
              key: 'nonInteractive',
              type: 'boolean',
              value: true,
              managed: true,
            },
          ]);
        } else if (!isInteractive && hasManagedNonInteractive) {
          this.commandOptions.update(list =>
            list.filter(o => !(o.key === 'nonInteractive' && o.managed))
          );
        }
      });
    });
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private matchesProviderRule(rule: string | undefined, provider?: string): boolean {
    if (!rule) return true;
    if (!provider) return false;
    const negated = rule.startsWith('!');
    const parts = (negated ? rule.slice(1) : rule).split(',').map(p => p.trim());
    return negated ? !parts.includes(provider) : parts.includes(provider);
  }

  private getFilteredField(field: RcConfigOption, provider?: string): RcConfigOption {
    if (!field.Examples?.length || !provider) return field;
    return {
      ...field,
      Examples: field.Examples.filter(ex => this.matchesProviderRule(ex.Provider, provider)),
    };
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
      .filter(f => matchesConfigSearch(f, query));
  }

  private clearProviderDependentFields(
    fields: RcConfigOption[],
    form: FormGroup,
    newProvider: string
  ): void {
    for (const field of fields) {
      const control = form.get(field.Name);
      if (!control) continue;

      if (field.Provider && !this.matchesProviderRule(field.Provider, newProvider)) {
        control.setValue(null);
        continue;
      }

      if (field.Examples?.length) {
        const current = control.value;
        if (current && !this.isValueValidForProvider(field, current, newProvider)) {
          control.setValue('');
        }
      }
    }
  }

  private isValueValidForProvider(field: RcConfigOption, value: string, provider: string): boolean {
    const match = field.Examples?.find(ex => ex.Value === value);
    return !(match && !this.matchesProviderRule(match.Provider, provider));
  }

  // ── Template bindings ─────────────────────────────────────────────────────

  readonly displayRemote = (value: string): string =>
    this.remoteTypes().find(t => t.value === value)?.label ?? value ?? '';

  readonly displayProvider = (value: string): string =>
    this.providerField()?.Examples?.find(o => o.Value === value)?.Help ?? value;

  onTypeSelected(value: string): void {
    this.form().get('type')?.setValue(value);
    this.generateRemoteName(value);
    this.remoteTypeChanged.emit();
  }

  private generateRemoteName(remoteType: string): void {
    const nameControl = this.form().get('name');
    if (!nameControl || (nameControl.value && nameControl.dirty)) return;

    const base = remoteType.replace(/\s+/g, '');
    const existing = new Set(this.existingRemotes());
    let name = base;
    let n = 1;
    while (existing.has(name)) name = `${base}-${n++}`;

    nameControl.setValue(name, { emitEvent: true });
    nameControl.updateValueAndValidity({ emitEvent: false });
    if (nameControl.invalid) nameControl.markAsTouched();
  }

  toggleJsonMode(): void {
    this.showJsonMode.update(v => !v);
  }

  toggleAdvancedOptions(): void {
    this.advancedOptionsToggled.emit(!this.showAdvancedOptions());
  }

  toggleCommandOptions(): void {
    this.showCommandOptions.update(v => !v);
  }

  onProviderSelected(value: string): void {
    const field = this.providerField();
    if (field) this.form().get(field.Name)?.setValue(value);
  }

  onFieldChanged(fieldName: string, isChanged: boolean): void {
    this.fieldChanged.emit({ fieldName, isChanged });
  }

  // ── Command option mutations ──────────────────────────────────────────────

  addPredefinedOption(predefined: PredefinedOption): void {
    this.commandOptions.update(opts => [
      ...opts,
      {
        id: crypto.randomUUID(),
        key: predefined.key,
        type: predefined.type,
        value: predefined.defaultValue,
        managed: false,
      },
    ]);
  }

  addCustomOption(): void {
    const key = this.newOptionKey().trim();
    if (!key) return;

    const type = this.newOptionType();
    const value: CommandOption['value'] =
      type === 'boolean' ? true : type === 'number' ? 0 : type === 'array' ? [] : '';

    this.commandOptions.update(opts => [...opts, { id: crypto.randomUUID(), key, type, value }]);
    this.newOptionKey.set('');
  }

  removeOption(id: string): void {
    this.commandOptions.update(opts => opts.filter(o => o.id !== id));
  }

  // Single update method — replaces separate updateBooleanOption / updateStringOption
  updateOption(id: string, value: CommandOption['value']): void {
    this.commandOptions.update(opts => opts.map(o => (o.id === id ? { ...o, value } : o)));
  }

  // Number input needs parsing before the generic update
  updateNumberOption(id: string, rawValue: string): void {
    const num = parseFloat(rawValue);
    if (!isNaN(num)) this.updateOption(id, num);
  }

  addArrayChip(id: string, event: MatChipInputEvent): void {
    const val = event.value.trim();
    if (!val) return;
    this.commandOptions.update(opts =>
      opts.map(o => (o.id === id ? { ...o, value: [...(o.value as string[]), val] } : o))
    );
    event.chipInput!.clear();
  }

  removeArrayChip(id: string, chip: string): void {
    this.commandOptions.update(opts =>
      opts.map(o =>
        o.id === id ? { ...o, value: (o.value as string[]).filter(v => v !== chip) } : o
      )
    );
  }

  // ── Template type helpers ─────────────────────────────────────────────────

  asStringArray(value: CommandOption['value']): string[] {
    return Array.isArray(value) ? value : [];
  }

  asString(value: CommandOption['value']): string {
    return typeof value === 'string' ? value : String(value);
  }
}
