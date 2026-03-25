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
  PREDEFINED_OPTIONS,
} from '@app/types';
import { IconService, matchesConfigSearch, RemoteManagementService } from '@app/services';
import { JsonEditorComponent, SettingControlComponent } from 'src/app/shared/components';

const _obscureOption = PREDEFINED_OPTIONS.find(o => o.key === 'obscure');
export const INITIAL_COMMAND_OPTIONS: CommandOption[] = _obscureOption
  ? [{ ..._obscureOption }]
  : [];

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
  private readonly remoteManagementService = inject(RemoteManagementService);
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
  readonly showCommandField = computed(() => this.visibility().commands !== false);

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
  readonly newOptionType = signal<'boolean' | 'string' | 'number' | 'array'>('boolean');
  readonly randomIcon = signal('cloud');
  readonly animTrigger = signal(0);
  readonly suggestedRemotes = signal<RemoteType[]>([]);

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

  readonly providerReady = computed(
    () => !!this.remoteTypeValue() && (!this.providerField() || !!this.selectedProvider())
  );

  readonly jsonExcludeKeys = computed(() => (this.isTypeLocked() ? ['type', 'name'] : []));

  readonly availablePredefinedOptions = computed(() => {
    const active = new Set(this.commandOptions().map(o => o.key));
    return PREDEFINED_OPTIONS.filter(p => !active.has(p.key));
  });

  getOptionType(value: CommandOption['value']): 'boolean' | 'string' | 'number' | 'array' {
    if (Array.isArray(value)) return 'array';
    const type = typeof value;
    if (type === 'boolean' || type === 'number') return type;
    return 'string';
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  private _cmdOptsReady = false;

  constructor() {
    effect(() => {
      const opts = this.commandOptions();
      if (this._cmdOptsReady) this.commandOptionsChanged.emit(opts);
      else this._cmdOptsReady = true;
    });

    effect(() => {
      const initial = this.initialCommandOptions();
      if (initial !== undefined) {
        untracked(() => this.commandOptions.set(initial));
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
      const types = this.remoteTypes();
      if (types.length > 0 && untracked(this.suggestedRemotes).length === 0) {
        this.suggestedRemotes.set(this.shuffleSample(types));
      }
    });

    effect(() => {
      const isInteractive = this.remoteManagementService.isInteractiveRemote(
        this.remoteTypeValue()
      );

      untracked(() => {
        const opts = this.commandOptions();
        const hasNonInteractive = opts.some(o => o.key === 'nonInteractive');
        if (isInteractive && !hasNonInteractive) {
          this.commandOptions.update(list => [...list, { key: 'nonInteractive', value: true }]);
        } else if (!isInteractive && hasNonInteractive) {
          this.commandOptions.update(list => list.filter(o => o.key !== 'nonInteractive'));
        }
      });
    });

    effect(onCleanup => {
      if (this.showTypeField() && !this.remoteTypeValue() && !this.isLoading()) {
        const types = this.remoteTypes();
        if (types.length === 0) return;

        const icons = types.map(t => this.iconService.getIconName(t.value));
        const pickNextIcon = (): string => {
          if (icons.length === 1) return icons[0];
          const current = this.randomIcon();
          let nextIcon: string;
          do {
            nextIcon = icons[Math.floor(Math.random() * icons.length)];
          } while (nextIcon === current);
          return nextIcon;
        };

        const id = setInterval(() => {
          this.randomIcon.set(pickNextIcon());
          this.animTrigger.update(v => v + 1);
        }, 3000);
        onCleanup(() => clearInterval(id));
      } else {
        this.randomIcon.set('cloud');
        this.animTrigger.set(0);
      }
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

  private shuffleSample(list: RemoteType[], count = 5): RemoteType[] {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, count);
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

  clearType(): void {
    this.form().get('type')?.setValue('');
    this.remoteSearchCtrl.setValue('');
    this.remoteTypeChanged.emit();
  }

  stopAndClearType(event: MouseEvent): void {
    event.stopPropagation();
    this.clearType();
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

  addPredefinedOption(predefined: CommandOption): void {
    this.commandOptions.update(opts => [...opts, { ...predefined }]);
  }

  addCustomOption(): void {
    const key = this.newOptionKey().trim();
    if (!key) return;

    const type = this.newOptionType();
    const value: CommandOption['value'] =
      type === 'boolean' ? true : type === 'number' ? 0 : type === 'array' ? [] : '';

    this.commandOptions.update(opts => [...opts, { key, value }]);
    this.newOptionKey.set('');
  }

  removeOption(key: string): void {
    this.commandOptions.update(opts => opts.filter(o => o.key !== key));
  }

  updateOption(key: string, value: CommandOption['value']): void {
    this.commandOptions.update(opts => opts.map(o => (o.key === key ? { ...o, value } : o)));
  }

  updateNumberOption(key: string, rawValue: string): void {
    const num = parseFloat(rawValue);
    if (!isNaN(num)) this.updateOption(key, num);
  }

  addArrayChip(key: string, event: MatChipInputEvent): void {
    const val = event.value.trim();
    if (!val) return;
    this.commandOptions.update(opts =>
      opts.map(o => (o.key === key ? { ...o, value: [...(o.value as string[]), val] } : o))
    );
    event.chipInput.clear();
  }

  removeArrayChip(key: string, index: number): void {
    this.commandOptions.update(opts =>
      opts.map(o =>
        o.key === key ? { ...o, value: (o.value as string[]).filter((_, i) => i !== index) } : o
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

  asBoolean(value: CommandOption['value']): boolean {
    return typeof value === 'boolean' ? value : false;
  }

  reshuffleSuggestions(): void {
    this.suggestedRemotes.set(this.shuffleSample(this.remoteTypes()));
  }
}
