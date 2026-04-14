import {
  Component,
  HostListener,
  inject,
  ChangeDetectionStrategy,
  signal,
  computed,
  OnDestroy,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { map } from 'rxjs/operators';
import {
  AbstractControl,
  FormArray,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidatorFn,
  Validators,
} from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatDialogRef } from '@angular/material/dialog';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';

import { ValidatorRegistryService, ModalService } from '@app/services';
import { AppSettingsService, FileSystemService } from '@app/services';
import { SearchResult, SettingMetadata, SettingTab } from '@app/types';

interface PendingChange {
  category: string;
  key: string;
  value: unknown;
  metadata: SettingMetadata;
}

interface PendingChangeDisplay {
  displayName: string;
  category: string;
  key: string;
  value: unknown;
}

@Component({
  selector: 'app-preferences-modal',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatSlideToggleModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    SearchContainerComponent,
    TranslateModule,
    NgTemplateOutlet,
  ],
  templateUrl: './preferences-modal.component.html',
  styleUrls: ['./preferences-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreferencesModalComponent implements OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly appSettingsService = inject(AppSettingsService);
  private readonly fileSystemService = inject(FileSystemService);
  private readonly validatorRegistry = inject(ValidatorRegistryService);
  private readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);
  private readonly dialogRef = inject(MatDialogRef<PreferencesModalComponent>);

  settingsForm: FormGroup = this.fb.group({});

  // ── Signals ───────────────────────────────────────────────────────────────

  readonly isLoading = signal(true);
  readonly selectedTabIndex = signal(0);
  readonly bottomTabs = signal(false);
  readonly searchQuery = signal('');
  readonly searchVisible = signal(false);
  readonly pendingRestartChanges = signal<Map<string, PendingChange>>(new Map());
  readonly enrichedOptions = signal<Record<string, SettingMetadata>>({});

  // Tabs are static; if they become dynamic, derive from a service instead.
  readonly tabs: SettingTab[] = [
    { label: 'modals.preferences.tabs.general', icon: 'wrench', key: 'general' },
    { label: 'modals.preferences.tabs.core', icon: 'core', key: 'core' },
    { label: 'modals.preferences.tabs.developer', icon: 'experiment', key: 'developer' },
  ];

  // ── Computed Signals ──────────────────────────────────────────────────────

  readonly searchSuggestions = signal<string[]>([]);

  readonly searchResults = computed((): SearchResult[] => {
    const query = this.searchQuery().toLowerCase();
    const options = this.enrichedOptions();
    if (!query) return [];

    const results: SearchResult[] = [];
    for (const [fullKey, meta] of Object.entries(options)) {
      const displayName = meta.metadata?.display_name || meta.metadata?.label || '';
      const helpText = meta.metadata?.help_text || meta.metadata?.description || '';
      if (displayName.toLowerCase().includes(query) || helpText.toLowerCase().includes(query)) {
        const { category, key } = this.splitKey(fullKey);
        if (this.tabs.some(t => t.key === category)) {
          results.push({ category, key });
        }
      }
    }
    return results;
  });

  readonly selectedTabKey = computed(
    () => this.tabs[this.selectedTabIndex()]?.key ?? this.tabs[0].key
  );

  readonly selectedTabKeys = computed(() => {
    this.enrichedOptions(); // track form rebuilds
    const group = this.settingsForm.get(this.selectedTabKey());
    return group ? Object.keys(group.value ?? {}) : [];
  });

  readonly isGeneralTab = computed(() => this.selectedTabKey() === 'general');
  readonly hasSearchResults = computed(() => !!this.searchQuery());
  readonly hasPendingRestartChanges = computed(() => this.pendingRestartChanges().size > 0);
  readonly pendingChangesCount = computed(() => this.pendingRestartChanges().size);

  readonly pendingChangesList = computed((): PendingChangeDisplay[] =>
    Array.from(this.pendingRestartChanges().values()).map(change => ({
      displayName:
        change.metadata.metadata?.display_name || change.metadata.metadata?.label || change.key,
      category: change.category,
      key: change.key,
      value: change.value,
    }))
  );

  private readonly HOLD_DELAY = 300;
  private readonly HOLD_INTERVAL = 75;
  private readonly ALLOWED_INTEGER_KEYS = new Set([
    'Backspace',
    'Delete',
    'Tab',
    'Escape',
    'Enter',
    'Home',
    'End',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
  ]);
  private holdTimeout: ReturnType<typeof setTimeout> | null = null;
  private holdInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.appSettingsService.options$
      .pipe(
        takeUntilDestroyed(),
        map(opts => this.enrichMetadata(opts || {}))
      )
      .subscribe(enriched => {
        this.enrichedOptions.set(enriched);
        const hasData = Object.keys(enriched).length > 0;
        if (hasData) this.buildForm(enriched);
        this.isLoading.set(!hasData);
      });

    this.populateSearchSuggestions();
    this.onResize();
  }

  ngOnDestroy(): void {
    this.stopHold(undefined, undefined, false);
  }

  // ── Init Helpers ──────────────────────────────────────────────────────────

  private populateSearchSuggestions(): void {
    const keys = ['apiPort', 'startup', 'debug', 'bandwidth'];
    this.translate
      .get(keys.map(k => `modals.preferences.searchSuggestions.${k}`))
      .pipe(takeUntilDestroyed())
      .subscribe(translations => this.searchSuggestions.set(Object.values(translations)));
  }

  @HostListener('window:resize')
  onResize(): void {
    this.bottomTabs.set(window.innerWidth < 540);
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  private enrichMetadata(
    options: Record<string, SettingMetadata>
  ): Record<string, SettingMetadata> {
    const enriched: Record<string, SettingMetadata> = {};
    for (const [fullKey, meta] of Object.entries(options)) {
      const [, key] = fullKey.split('.');
      let value_type = meta.value_type || this.inferValueType(meta, key);
      // A 'string' field with options is semantically a 'select' — normalize it
      // so the template switch only needs a single 'select' case.
      if (value_type === 'string' && meta.options?.length) value_type = 'select';
      enriched[fullKey] = { ...meta, value_type };
    }
    return enriched;
  }

  private inferValueType(meta: SettingMetadata, key: string): SettingMetadata['value_type'] {
    if (meta.options?.length) return 'select';
    if (key.includes('bandwidth')) return 'bandwidth';
    if (key.endsWith('_urls') || key.endsWith('_apps')) return 'string[]';
    if (key.includes('path') || key.includes('file')) return 'file';
    if (key.includes('folder') || key.includes('directory')) return 'folder';

    const def = meta.default;
    if (typeof def === 'boolean') return 'bool';
    if (typeof def === 'number') return 'int';
    if (Array.isArray(def)) return 'string[]';

    return 'string' as const;
  }

  // ── Form Building ─────────────────────────────────────────────────────────

  private buildForm(options: Record<string, SettingMetadata>): void {
    for (const fullKey in options) {
      const meta = options[fullKey];
      const { category, key } = this.splitKey(fullKey);

      if (!this.tabs.some(t => t.key === category)) continue;

      let categoryGroup = this.settingsForm.get(category) as FormGroup;
      if (!categoryGroup) {
        categoryGroup = this.fb.group({});
        this.settingsForm.addControl(category, categoryGroup);
      }

      const existingControl = categoryGroup.get(key);
      const validators = this.getValidators(meta, fullKey);

      if (existingControl) {
        if (!existingControl.dirty && !this.valuesEqual(existingControl.value, meta.value)) {
          if (existingControl instanceof FormArray && meta.value_type === 'string[]') {
            this.resetControlValue(existingControl, meta.value, meta);
          } else {
            existingControl.setValue(meta.value, { emitEvent: false });
          }
        }
      } else {
        const control: FormControl | FormArray =
          meta.value_type === 'string[]'
            ? this.fb.array(
                ((meta.value || []) as string[]).map(val =>
                  this.fb.control(val, this.getItemValidators(meta))
                ),
                validators
              )
            : this.fb.control(meta.value, validators);
        categoryGroup.addControl(key, control);
      }
    }
  }

  private normalizeValue(val: unknown): string {
    return val === null || val === undefined || val === '' ? '' : String(val);
  }

  private valuesEqual(a: unknown, b: unknown): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
      return a.length === b.length && a.every((val, idx) => val === b[idx]);
    }
    return this.normalizeValue(a) === this.normalizeValue(b);
  }

  // ── Form Event Handlers ───────────────────────────────────────────────────

  onBlur(category: string, key: string): void {
    this.commitSetting(category, key);
  }

  onValueChange(category: string, key: string): void {
    this.commitSetting(category, key);
  }

  private commitSetting(category: string, key: string): void {
    const control = this.getFormControl(category, key);
    if (control?.valid) this.updateSetting(category, key, control.value);
  }

  // ── Validators ────────────────────────────────────────────────────────────

  private getItemValidators(meta: SettingMetadata): ValidatorFn[] {
    return meta.reserved?.length ? [this.createReservedValidator(meta.reserved)] : [];
  }

  private createReservedValidator(reserved: string[]): ValidatorFn {
    return (control: AbstractControl): Record<string, unknown> | null => {
      const value = control.value;
      if (!value) return null;
      const isReserved = reserved.some(
        r => value === r || value.startsWith(r + '=') || value.startsWith(r + ' ')
      );
      return isReserved ? { reserved: { value, reservedValues: reserved } } : null;
    };
  }

  private getValidators(meta: SettingMetadata, fullKey: string): ValidatorFn[] {
    const validators: ValidatorFn[] = [];
    if (meta.metadata?.required) validators.push(Validators.required);

    switch (meta.value_type) {
      case 'int':
        validators.push(this.validatorRegistry.integerValidator());
        if (meta.min !== undefined) validators.push(Validators.min(meta.min));
        if (meta.max !== undefined) validators.push(Validators.max(meta.max));
        break;
      case 'file':
      case 'folder': {
        const v = this.validatorRegistry.getValidator('crossPlatformPath');
        if (v) validators.push(v);
        break;
      }
      case 'string[]':
        if (fullKey === 'core.connection_check_urls') {
          const v = this.validatorRegistry.getValidator('urlList');
          if (v) validators.push(v);
        }
        break;
      case 'bandwidth': {
        const v = this.validatorRegistry.getValidator('bandwidthFormat');
        if (v) validators.push(v);
        break;
      }
    }
    return validators;
  }

  // ── Settings CRUD ─────────────────────────────────────────────────────────

  updateSetting(category: string, key: string, value: unknown): void {
    const control = this.getFormControl(category, key);
    if (!control?.valid) return;

    const meta = this.getMetadata(category, key);
    let finalValue = value;

    if (meta.value_type === 'int' && typeof finalValue === 'string' && finalValue.trim() !== '') {
      finalValue = parseInt(finalValue, 10);
    }

    if (meta.value_type === 'string[]' && Array.isArray(finalValue)) {
      finalValue = finalValue.filter(item => item && String(item).trim() !== '');
    }

    const changeKey = `${category}.${key}`;
    if (meta.metadata?.engine_restart) {
      if (this.valuesEqual(meta.value, finalValue)) {
        this.deletePendingChange(changeKey);
      } else {
        this.setPendingChange(changeKey, { category, key, value: finalValue, metadata: meta });
      }
    } else if (!this.valuesEqual(meta.value, finalValue)) {
      this.appSettingsService.saveSetting(category, key, finalValue);
    }
  }

  async resetSetting(category: string, key: string): Promise<void> {
    const meta = this.getMetadata(category, key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defaultValue = (meta as any).default;
    const control = this.getFormControl(category, key);
    if (control) this.resetControlValue(control, defaultValue, meta);

    const changeKey = `${category}.${key}`;
    if (meta.metadata?.engine_restart) {
      this.setPendingChange(changeKey, { category, key, value: defaultValue, metadata: meta });
    } else {
      try {
        await this.appSettingsService.resetSetting(category, key);
      } catch (error) {
        console.error(`Failed to reset setting ${changeKey}`, error);
      }
    }
  }

  isModified(category: string, key: string): boolean {
    const meta = this.getMetadata(category, key);
    const control = this.getFormControl(category, key);
    if (!meta || !control) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return !this.valuesEqual((meta as any).default, control.value);
  }

  async resetSettings(): Promise<void> {
    try {
      await this.appSettingsService.resetSettings();
    } catch (error) {
      console.error('Error resetting settings:', error);
    }
  }

  async savePendingChanges(): Promise<void> {
    if (!this.hasPendingRestartChanges()) return;
    try {
      await Promise.all(
        Array.from(this.pendingRestartChanges().values()).map(({ category, key, value }) =>
          this.appSettingsService.saveSetting(category, key, value)
        )
      );
      this.clearPendingChanges();
    } catch (error) {
      console.error('Error saving pending changes:', error);
    }
  }

  discardPendingChanges(): void {
    for (const change of this.pendingRestartChanges().values()) {
      const originalValue = this.getMetadata(change.category, change.key).value;
      const control = this.getFormControl(change.category, change.key);
      if (control) this.resetControlValue(control, originalValue, change.metadata);
    }
    this.clearPendingChanges();
  }

  // ── Pending Change Map Helpers ────────────────────────────────────────────

  private setPendingChange(key: string, change: PendingChange): void {
    this.pendingRestartChanges.update(map => new Map(map).set(key, change));
  }

  private deletePendingChange(key: string): void {
    this.pendingRestartChanges.update(map => {
      const next = new Map(map);
      next.delete(key);
      return next;
    });
  }

  private clearPendingChanges(): void {
    this.pendingRestartChanges.set(new Map());
  }

  // ── Control Helpers ───────────────────────────────────────────────────────

  private resetControlValue(
    control: FormControl | FormArray,
    value: unknown,
    meta: SettingMetadata
  ): void {
    if (control instanceof FormArray) {
      const itemValidators = this.getItemValidators(meta);
      control.clear();
      (Array.isArray(value) ? value : []).forEach(val =>
        control.push(this.fb.control(val, itemValidators))
      );
    } else {
      control.setValue(value, { emitEvent: false });
    }
  }

  getFormControl(category: string, key: string): FormControl | FormArray {
    return this.settingsForm.get(category)?.get(key) as FormControl | FormArray;
  }

  getArrayItemControl(category: string, key: string, index: number): FormControl {
    return (this.getFormControl(category, key) as FormArray).at(index) as FormControl;
  }

  getArrayControls(category: string, key: string): AbstractControl[] {
    return (this.getFormControl(category, key) as FormArray).controls;
  }

  getMetadata(category: string, key: string): SettingMetadata {
    return this.enrichedOptions()[`${category}.${key}`];
  }

  /** Returns true for value types that render as a horizontal row (control beside label). */
  isRowLayout(category: string, key: string): boolean {
    const type = this.getMetadata(category, key)?.value_type;
    return type === 'bool' || type === 'int';
  }

  isControlInvalid(category: string, key: string, index?: number): boolean {
    const ctrl =
      index !== undefined
        ? this.getArrayItemControl(category, key, index)
        : this.getFormControl(category, key);
    return !!ctrl && ctrl.invalid && ctrl.touched;
  }

  // ── Display Helpers ───────────────────────────────────────────────────────

  private splitKey(fullKey: string): { category: string; key: string } {
    const [category, key] = fullKey.split('.');
    return { category, key };
  }

  getCategoryDisplayName(category: string): string {
    const tab = this.tabs.find(t => t.key === category);
    return tab
      ? this.translate.instant(tab.label)
      : category.charAt(0).toUpperCase() + category.slice(1);
  }

  getSettingLabel(_category: string, _key: string, meta: SettingMetadata): string {
    const labelKey = meta.metadata?.label || meta.metadata?.display_name;
    return labelKey ? this.translate.instant(labelKey) : _key;
  }

  getSettingDescription(_category: string, _key: string, meta: SettingMetadata): string {
    const descKey = meta.metadata?.description || meta.metadata?.help_text;
    return descKey ? this.translate.instant(descKey) : '';
  }

  getOptionLabel(option: unknown): string {
    const opt = option as { label?: unknown };
    return this.translate.instant(String(opt?.label ?? option));
  }

  getValidationMessage(category: string, key: string, index?: number): string {
    const ctrl =
      index !== undefined
        ? this.getArrayItemControl(category, key, index)
        : this.getFormControl(category, key);

    if (!ctrl?.errors) return '';

    const meta = this.getMetadata(category, key);
    const t = (k: string, p?: object) =>
      this.translate.instant(`modals.preferences.validation.${k}`, p);

    if (ctrl.hasError('required')) return t('required');
    if (ctrl.hasError('integer')) return t('integer');
    if (ctrl.hasError('min')) return t('min', { val: meta.min });
    if (ctrl.hasError('max')) return t('max', { val: meta.max });
    if (ctrl.hasError('invalidPath')) return t('invalidPath');
    if (ctrl.hasError('bandwidth')) return t('bandwidth');
    if (ctrl.hasError('urlArray')) return t('urlArray');
    if (ctrl.hasError('reserved')) return t('reserved', { value: ctrl.errors['reserved'].value });
    return t('invalid');
  }

  scrollToPendingChanges(): void {
    document.querySelector('.pending-changes-section')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }

  // Template utilities — Array.isArray / casting can't be called directly in Angular templates.
  isArray(value: unknown): boolean {
    return Array.isArray(value);
  }

  asArray(value: unknown): unknown[] {
    return value as unknown[];
  }

  // ── Keyboard & Search ─────────────────────────────────────────────────────

  onSearchTextChange(searchText: string): void {
    this.searchQuery.set(searchText.toLowerCase());
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }

  @HostListener('document:keydown.control.f', ['$event'])
  handleCtrlF(event: Event): void {
    event.preventDefault();
    this.toggleSearch();
  }

  toggleSearch(): void {
    this.searchVisible.update(v => !v);
    if (!this.searchVisible()) this.onSearchTextChange('');
  }

  selectTab(index: number): void {
    this.selectedTabIndex.set(index);
  }

  onPathInput(category: string, key: string): void {
    this.getFormControl(category, key).updateValueAndValidity();
  }

  // ── File / Folder Picker ──────────────────────────────────────────────────

  async openPicker(category: string, key: string, type: 'file' | 'folder'): Promise<void> {
    const result = await (type === 'file'
      ? this.fileSystemService.selectFile()
      : this.fileSystemService.selectFolder());
    if (result) this.getFormControl(category, key).setValue(result);
  }

  // ── Integer Stepper ───────────────────────────────────────────────────────

  onIntegerInput(event: KeyboardEvent): void {
    if (this.ALLOWED_INTEGER_KEYS.has(event.key) || event.ctrlKey || event.metaKey) return;
    if (!/^\d$/.test(event.key)) event.preventDefault();
  }

  startHold(
    action: 'increment' | 'decrement',
    category: string,
    key: string,
    meta: SettingMetadata
  ): void {
    this.stopHold(undefined, undefined, false);
    const performAction = () => this.stepNumber(action, category, key, meta);
    performAction();
    this.holdTimeout = setTimeout(() => {
      this.holdInterval = setInterval(performAction, this.HOLD_INTERVAL);
    }, this.HOLD_DELAY);
  }

  stopHold(category?: string, key?: string, _commit = true): void {
    if (this.holdTimeout) clearTimeout(this.holdTimeout);
    if (this.holdInterval) clearInterval(this.holdInterval);
    this.holdTimeout = null;
    this.holdInterval = null;
    if (_commit && category && key) this.commitSetting(category, key);
  }

  private stepNumber(
    action: 'increment' | 'decrement',
    category: string,
    key: string,
    meta: SettingMetadata
  ): void {
    const control = this.getFormControl(category, key) as FormControl;
    const step = meta.step || 1;
    const current = Number(control.value) || 0;
    const newValue = action === 'increment' ? current + step : current - step;
    const min = meta.min ?? -Infinity;
    const max = meta.max ?? Infinity;
    if (newValue >= min && newValue <= max) control.setValue(newValue);
  }

  addArrayItem(category: string, key: string): void {
    const control = this.getFormControl(category, key) as FormArray;
    const meta = this.getMetadata(category, key);
    control.push(this.fb.control('', this.getItemValidators(meta)));
  }

  removeArrayItem(category: string, key: string, index: number): void {
    const control = this.getFormControl(category, key) as FormArray;
    control.removeAt(index);
    this.updateSetting(category, key, control.value);
  }
}
