import { CommonModule } from '@angular/common';
import {
  Component,
  HostListener,
  OnInit,
  inject,
  ChangeDetectorRef,
  OnDestroy,
} from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTabsModule } from '@angular/material/tabs';
import {
  FormControl,
  ReactiveFormsModule,
  FormsModule,
  ValidatorFn,
  Validators,
  AbstractControl,
  FormGroup,
  FormArray,
  ValidationErrors,
} from '@angular/forms';

import { AnimationsService } from '../../../../shared/services/animations.service';
import { FlagConfigService, RcloneBackendOptionsService } from '@app/services';
import { NotificationService } from '../../../../shared/services/notification.service';
import { RcConfigOption } from '@app/types';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { SecuritySettingsComponent } from '../security-settings/security-settings.component';
import { debounceTime, distinctUntilChanged, Subject, takeUntil } from 'rxjs';

type PageType = 'home' | 'security' | string;
type GroupedRCloneOptions = Record<string, Record<string, RcConfigOption[]>>;

interface RCloneService {
  name: string;
  expanded: boolean;
  categories: string[];
}

interface SearchResult {
  service: string;
  category: string;
  option: RcConfigOption;
}

@Component({
  selector: 'app-rclone-config-modal',
  standalone: true,
  imports: [
    CommonModule,
    MatDividerModule,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    MatFormFieldModule,
    MatInputModule,
    ReactiveFormsModule,
    FormsModule,
    MatTooltipModule,
    MatTabsModule,
    MatSelectModule,
    MatExpansionModule,
    SearchContainerComponent,
    SecuritySettingsComponent,
  ],
  templateUrl: './rclone-config-modal.component.html',
  styleUrl: './rclone-config-modal.component.scss',
  animations: [AnimationsService.slideOverlay()],
})
export class RcloneConfigModalComponent implements OnInit, OnDestroy {
  // --- Injected Services & DialogRef ---
  private dialogRef = inject(MatDialogRef<RcloneConfigModalComponent>);
  private notificationService = inject(NotificationService);
  private flagConfigService = inject(FlagConfigService);
  private rcloneBackendOptionsService = inject(RcloneBackendOptionsService);
  private cdRef = inject(ChangeDetectorRef);

  // --- Public Properties (for the template) ---
  currentPage: PageType = 'home';
  currentCategory: string | null = null;
  isLoading = true;
  rcloneOptionsForm: FormGroup;
  services: RCloneService[] = [];
  filteredServices: RCloneService[] = [];
  globalSearchResults: SearchResult[] = [];
  searchQuery = '';
  isSearchVisible = false;
  savingOptions = new Set<string>();
  searchMatchCounts = new Map<string, number>();

  // --- Private Properties ---
  private readonly componentDestroyed$ = new Subject<void>();
  private readonly search$ = new Subject<string>();
  private groupedRcloneOptions: GroupedRCloneOptions = {};
  private optionToFocus: string | null = null;
  private optionToServiceMap: Record<string, string> = {};
  private optionToCategoryMap: Record<string, string> = {};
  private optionToFullFieldNameMap: Record<string, string> = {};

  // Enhanced icon mapping with better visual consistency
  private readonly serviceIconMap: Record<string, string> = {
    vfs: 'vfs',
    mount: 'mount',
    filter: 'filter',
    main: 'gear',
    log: 'file-lines',
    http: 'globe',
    rc: 'server',
    dlna: 'tv',
    ftp: 'file-arrow-up',
    nfs: 'database',
    proxy: 'shield-halved',
    restic: 'box-archive',
    s3: 'bucket',
    sftp: 'lock',
    webdav: 'cloud',
  };

  private readonly serviceDescriptionMap: Record<string, string> = {
    vfs: 'Virtual File System caching and performance settings',
    mount: 'Mount-specific options and FUSE configuration',
    filter: 'File filtering rules and patterns',
    main: 'General RClone operation and transfer settings',
    log: 'Logging configuration and output settings',
    http: 'HTTP server settings',
    rc: 'Remote control server configuration',
    dlna: 'DLNA server settings',
    ftp: 'FTP server configuration',
    nfs: 'NFS server settings',
    proxy: 'Proxy authentication settings',
    restic: 'Restic server configuration',
    s3: 'S3 server settings',
    sftp: 'SFTP server configuration',
    webdav: 'WebDAV server settings',
  };

  private readonly categoryDescriptionMap: Record<string, string> = {
    General: 'General configuration options',
    Auth: 'Authentication and credentials',
    HTTP: 'HTTP-specific settings',
    Template: 'Template settings',
    MetaRules: 'Meta rule configurations',
    RulesOpt: 'Rule options',
    MetricsAuth: 'Metrics authentication',
    MetricsHTTP: 'Metrics HTTP settings',
  };

  private readonly serviceCategoryMap: Record<string, string> = {
    main: 'General Settings',
    log: 'General Settings',
    vfs: 'File System & Storage',
    mount: 'File System & Storage',
    filter: 'File System & Storage',
    dlna: 'Network & Servers',
    http: 'Network & Servers',
    rc: 'General Settings',
    ftp: 'Network & Servers',
    sftp: 'Network & Servers',
    webdav: 'Network & Servers',
    s3: 'Network & Servers',
    nfs: 'Network & Servers',
    restic: 'Network & Servers',
    proxy: 'General Settings',
  };

  private readonly mainCategoryDescriptionMap: Record<string, string> = {
    'General Settings': 'Core RClone options and logging configuration',
    'File System & Storage': 'Virtual file system, mounting, filtering, and storage options',
    'Network & Servers': 'HTTP, FTP, SFTP, WebDAV, S3, and other network service settings',
  };

  private readonly mainCategoryIconMap: Record<string, string> = {
    'General Settings': 'gear',
    'File System & Storage': 'folder',
    'Network & Servers': 'public',
  };

  constructor() {
    this.rcloneOptionsForm = new FormGroup({});
    // The search subscription now handles logic for ALL pages
    this.search$
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntil(this.componentDestroyed$))
      .subscribe(searchText => {
        const query = searchText.toLowerCase().trim();
        this.searchQuery = query;

        // Only perform global search if we are on the home page
        if (this.currentPage === 'home') {
          if (!query) {
            this.globalSearchResults = [];
            this.filteredServices = [...this.services].map(s => ({ ...s, expanded: false }));
          } else {
            this.performGlobalSearch(query);
            this.updateFilteredServices();
          }
        }
        // No 'else' block needed. The settings page filter is handled reactively by the template.
        this.cdRef.detectChanges();
      });
  }

  ngOnDestroy(): void {
    this.componentDestroyed$.next();
    this.componentDestroyed$.complete();
  }

  onSearchInput(searchText: string): void {
    this.search$.next(searchText);
  }

  getSearchPlaceholder(): string {
    return this.currentPage === 'home'
      ? 'Search all services and settings...'
      : `Search in ${this.currentPage.toUpperCase()}...`;
  }

  getMatchCountForCategory(serviceName: string, categoryName: string): number {
    const key = `${serviceName}---${categoryName}`;
    return this.searchMatchCounts.get(key) || 0;
  }

  async ngOnInit(): Promise<void> {
    await this.loadAndBuildOptions();
    this.isLoading = false;
    this.cdRef.detectChanges();
  }

  private async loadAndBuildOptions(): Promise<void> {
    try {
      this.groupedRcloneOptions = await this.flagConfigService.getGroupedOptions();
      this.buildServices();
      this.createRCloneOptionControls();
      this.cdRef.detectChanges();
    } catch (error) {
      console.error('Failed to load RClone configuration:', error);
      this.notificationService.showError('Failed to load RClone configuration');
    }
  }

  private buildServices(): void {
    this.services = Object.keys(this.groupedRcloneOptions).map(serviceName => ({
      name: serviceName,
      expanded: false,
      categories: Object.keys(this.groupedRcloneOptions[serviceName]),
    }));
    this.filteredServices = [...this.services];
  }

  private createRCloneOptionControls(): void {
    for (const service in this.groupedRcloneOptions) {
      for (const category in this.groupedRcloneOptions[service]) {
        for (const option of this.groupedRcloneOptions[service][category]) {
          const fullFieldName =
            category === 'General' ? option.FieldName : `${category}.${option.FieldName}`;
          const uniqueControlKey = `${service}---${category}---${option.Name}`;

          this.optionToServiceMap[uniqueControlKey] = service;
          this.optionToCategoryMap[uniqueControlKey] = category;
          this.optionToFullFieldNameMap[uniqueControlKey] = fullFieldName;

          const validators = this.getRCloneOptionValidators(option);
          let initialValue: unknown = option.Value;

          if (option.Type === 'stringArray') {
            const arrayValues = (Array.isArray(initialValue) ? initialValue : []).filter(v => v);
            this.rcloneOptionsForm.addControl(
              uniqueControlKey,
              new FormArray(
                arrayValues.map(val => new FormControl(val)),
                validators
              )
            );
          } else {
            if (option.Type === 'bool') {
              initialValue = initialValue === true || initialValue === 'true';
            }
            const control = new FormControl(initialValue, validators);
            this.rcloneOptionsForm.addControl(uniqueControlKey, control);
          }
        }
      }
    }
  }

  // Main Category Grouping
  getServicesByMainCategory(): Record<string, RCloneService[]> {
    const grouped: Record<string, RCloneService[]> = {
      'General Settings': [],
      'File System & Storage': [],
      'Network & Servers': [],
    };

    this.filteredServices.forEach(service => {
      const mainCategory = this.serviceCategoryMap[service.name] || 'Network & Servers';
      if (grouped[mainCategory]) {
        grouped[mainCategory].push(service);
      }
    });

    return grouped;
  }

  getMainCategoryDescription(category: string): string {
    return this.mainCategoryDescriptionMap[category] || '';
  }

  getMainCategoryIcon(category: string): string {
    return this.mainCategoryIconMap[category] || 'gear';
  }

  // Service and category methods
  getServiceIcon(serviceName: string): string {
    return this.serviceIconMap[serviceName] || 'gear';
  }

  getServiceDescription(serviceName: string): string {
    return this.serviceDescriptionMap[serviceName] || '';
  }

  getServiceCategories(serviceName: string): string[] {
    return this.groupedRcloneOptions[serviceName]
      ? Object.keys(this.groupedRcloneOptions[serviceName])
      : [];
  }

  getCategoryIcon(categoryName: string): string {
    const iconMap: Record<string, string> = {
      General: 'gear',
      Auth: 'lock',
      HTTP: 'globe',
      Template: 'terminal',
      MetaRules: 'chart',
      RulesOpt: 'filter',
      MetricsAuth: 'lock',
      MetricsHTTP: 'globe',
    };
    return iconMap[categoryName] || 'gear';
  }

  getCategoryDescription(categoryName: string): string {
    return this.categoryDescriptionMap[categoryName] || '';
  }

  // Navigation and page management
  navigateTo(service: string, category?: string, optionName?: string): void {
    if (service === 'security') {
      this.currentPage = 'security';
      this.currentCategory = null;
    } else {
      this.currentPage = service;
      this.currentCategory = category || null;
    }

    this.optionToFocus = optionName || null;
    this.cdRef.detectChanges();

    // The scroll logic now lives here again.
    if (this.optionToFocus) {
      setTimeout(() => {
        const element = document.getElementById(`setting-${this.optionToFocus}`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          element.classList.add('highlighted');
          setTimeout(() => {
            element.classList.remove('highlighted');
          }, 1500);
        }
        this.optionToFocus = null;
      }, 100); // A small delay is sufficient.
    }
  }

  getRCloneOptionsForCurrentPage(): RcConfigOption[] {
    if (this.currentPage === 'home' || this.currentPage === 'security' || !this.currentCategory) {
      return [];
    }

    const options = this.groupedRcloneOptions[this.currentPage]?.[this.currentCategory] || [];
    return this.filterOptionsBySearch(options);
  }

  private filterOptionsBySearch(options: RcConfigOption[]): RcConfigOption[] {
    if (!this.searchQuery || this.searchQuery.trim() === '') return options;

    const query = this.searchQuery.toLowerCase().trim();
    return options.filter(
      option =>
        option.Name.toLowerCase().includes(query) ||
        option.FieldName.toLowerCase().includes(query) ||
        option.Help.toLowerCase().includes(query)
    );
  }

  private performGlobalSearch(query: string): void {
    this.globalSearchResults = [];
    for (const service in this.groupedRcloneOptions) {
      for (const category in this.groupedRcloneOptions[service]) {
        for (const option of this.groupedRcloneOptions[service][category]) {
          if (
            option.Name.toLowerCase().includes(query) ||
            option.FieldName.toLowerCase().includes(query) ||
            option.Help.toLowerCase().includes(query) ||
            service.toLowerCase().includes(query) ||
            category.toLowerCase().includes(query)
          ) {
            this.globalSearchResults.push({ service, category, option });
          }
        }
      }
    }
  }

  private updateFilteredServices(): void {
    this.searchMatchCounts.clear(); // Clear old counts

    if (this.globalSearchResults.length > 0) {
      // Tally up the counts
      this.globalSearchResults.forEach(result => {
        const key = `${result.service}---${result.category}`;
        const currentCount = this.searchMatchCounts.get(key) || 0;
        this.searchMatchCounts.set(key, currentCount + 1);
      });

      const servicesWithMatches = new Set(this.globalSearchResults.map(r => r.service));
      this.filteredServices = this.services
        .filter(svc => servicesWithMatches.has(svc.name))
        .map(svc => ({ ...svc, expanded: true }));
    } else {
      const query = this.searchQuery.toLowerCase().trim();
      this.filteredServices = this.services
        .filter(
          svc =>
            svc.name.toLowerCase().includes(query) ||
            (this.serviceDescriptionMap[svc.name] || '').toLowerCase().includes(query)
        )
        .map(svc => ({ ...svc, expanded: true }));
    }
  }

  toggleSearchVisibility(): void {
    this.isSearchVisible = !this.isSearchVisible;
    if (!this.isSearchVisible) {
      this.searchQuery = '';
      this.onSearchInput('');
    }
    this.cdRef.detectChanges();
  }

  // Getters for template
  get hasSearchQuery(): boolean {
    return this.searchQuery.trim().length > 0;
  }

  get filteredOptionsCount(): number {
    if (this.currentPage === 'home' || this.currentPage === 'security' || !this.currentCategory) {
      return 0;
    }
    return this.getRCloneOptionsForCurrentPage().length;
  }

  get totalOptionsCount(): number {
    if (this.currentPage === 'home' || this.currentPage === 'security' || !this.currentCategory) {
      return 0;
    }
    return (this.groupedRcloneOptions[this.currentPage]?.[this.currentCategory] || []).length;
  }

  get isSecurityPage(): boolean {
    return this.currentPage === 'security';
  }

  // Form control management
  async saveRCloneOption(optionName: string): Promise<void> {
    const uniqueKey = `${this.currentPage}---${this.currentCategory}---${optionName}`;
    const control = this.rcloneOptionsForm.get(uniqueKey);

    if (!control || control.invalid || this.savingOptions.has(uniqueKey) || control.pristine) {
      return;
    }

    try {
      this.savingOptions.add(uniqueKey);
      control.disable({ emitEvent: false });

      const service = this.optionToServiceMap[uniqueKey];
      const fullFieldName = this.optionToFullFieldNameMap[uniqueKey];

      if (!service || !fullFieldName) {
        throw new Error(`Mapping not found for ${uniqueKey}`);
      }

      let valueToSave = control.value;
      if (Array.isArray(valueToSave)) {
        valueToSave = valueToSave.filter(v => v);
      }

      await this.flagConfigService.saveOption(service, fullFieldName, valueToSave);
      await this.rcloneBackendOptionsService.saveOption(service, fullFieldName, valueToSave);
      control.markAsPristine();
      this.notificationService.showSuccess(`Saved: ${fullFieldName}`);
    } catch (error) {
      console.error(`Failed to save option ${uniqueKey}:`, error);
      this.notificationService.showError(`Failed to save ${optionName}`);
    } finally {
      this.savingOptions.delete(uniqueKey);
      if (control) control.enable({ emitEvent: false });
    }
  }

  getRCloneOptionControl(optionName: string): AbstractControl | null {
    const uniqueKey = `${this.currentPage}---${this.currentCategory}---${optionName}`;
    return this.rcloneOptionsForm.get(uniqueKey);
  }

  addArrayItem(optionName: string): void {
    const uniqueKey = `${this.currentPage}---${this.currentCategory}---${optionName}`;
    const formArray = this.rcloneOptionsForm.get(uniqueKey) as FormArray;
    formArray.push(new FormControl(''));
    formArray.markAsDirty();
    this.saveRCloneOption(optionName);
  }

  removeArrayItem(optionName: string, index: number): void {
    const uniqueKey = `${this.currentPage}---${this.currentCategory}---${optionName}`;
    const formArray = this.rcloneOptionsForm.get(uniqueKey) as FormArray;
    formArray.removeAt(index);
    formArray.markAsDirty();
    this.saveRCloneOption(optionName);
  }

  getFormArrayControls(optionName: string): AbstractControl[] {
    const uniqueKey = `${this.currentPage}---${this.currentCategory}---${optionName}`;
    const formArray = this.rcloneOptionsForm.get(uniqueKey) as FormArray;
    return formArray ? formArray.controls : [];
  }

  // Validators
  getRCloneOptionValidators(option: RcConfigOption): ValidatorFn[] {
    const validators: ValidatorFn[] = [];

    if (option.Required) {
      validators.push(Validators.required);
    }

    switch (option.Type) {
      case 'int':
      case 'int64':
      case 'uint32':
        validators.push(this.integerValidator(option.DefaultStr));
        break;
      case 'float64':
        validators.push(this.floatValidator(option.DefaultStr));
        break;
      case 'Duration':
        validators.push(this.durationValidator(option.DefaultStr));
        break;
      case 'SizeSuffix':
        validators.push(this.sizeSuffixValidator(option.DefaultStr));
        break;
      case 'BwTimetable':
        validators.push(this.bwTimetableValidator(option.DefaultStr));
        break;
      case 'FileMode':
        validators.push(this.fileModeValidator(option.DefaultStr));
        break;
      case 'Time':
        validators.push(this.timeValidator(option.DefaultStr));
        break;
      case 'SpaceSepList':
        validators.push(this.spaceSepListValidator(option.DefaultStr));
        break;
      case 'Bits':
        validators.push(this.bitsValidator(option.DefaultStr));
        break;
      case 'Tristate': // ADD THIS CASE
        validators.push(this.tristateValidator());
        break;
      case 'LogLevel':
      case 'CacheMode':
        if (option.Examples) {
          validators.push(this.enumValidator(option.Examples.map(e => e.Value)));
        }
        break;
    }

    if (option.Exclusive && option.Examples) {
      validators.push(this.enumValidator(option.Examples.map(e => e.Value)));
    }

    return validators;
  }

  private integerValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (!/^-?\d+$/.test(value)) {
        return { integer: { value, message: 'Must be a valid integer' } };
      }
      return isNaN(parseInt(value, 10)) ? { integer: { value, message: 'Invalid integer' } } : null;
    };
  }

  private floatValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      if (!/^-?\d+(\.\d+)?$/.test(value)) {
        return { float: { value, message: 'Must be a valid decimal number' } };
      }
      return isNaN(parseFloat(value)) ? { float: { value, message: 'Invalid float' } } : null;
    };
  }

  private durationValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      const durationPattern = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/;
      return !durationPattern.test(value)
        ? { duration: { value, message: 'Invalid duration format. Use: 1h30m45s, 5m, 1h' } }
        : null;
    };
  }

  private tristateValidator(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const allowedValues = [null, true, false];
      if (allowedValues.includes(control.value)) {
        return null; // Value is valid
      }
      return {
        tristate: { value: control.value, message: 'Value must be true, false, or unset.' },
      };
    };
  }

  private bitsValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }
      if (value.length > 0 && !/^[a-zA-Z0-9_-]+(,\s*[a-zA-Z0-9_-]+)*$/.test(value)) {
        return {
          bits: {
            value,
            message: 'Must be comma-separated flags (alphanumeric, underscore, and hyphen)',
          },
        };
      }

      return null;
    };
  }

  private timeValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      // Allow the option's default value
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }

      // ISO 8601 datetime format check
      const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)?$/;

      if (!isoPattern.test(value)) {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          return {
            time: {
              value,
              message: 'Invalid datetime format. Use ISO 8601: YYYY-MM-DDTHH:mm:ssZ',
            },
          };
        }
      }

      return null;
    };
  }

  private spaceSepListValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;

      const value = control.value.toString().trim();

      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) {
        return null;
      }
      if (value.length > 0 && !/\S/.test(value)) {
        return {
          spaceSepList: {
            value,
            message: 'List cannot contain only whitespace',
          },
        };
      }

      return null;
    };
  }

  private sizeSuffixValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      const sizePattern = /^\d+(\.\d+)?(b|B|k|K|Ki|M|Mi|G|Gi|T|Ti|P|Pi|E|Ei)?$/;
      return !sizePattern.test(value)
        ? { sizeSuffix: { value, message: 'Invalid size format. Use: 100Ki, 16Mi, 1Gi, 2.5G' } }
        : null;
    };
  }

  private bwTimetableValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      const simpleBandwidth = /^\d+(\.\d+)?(B|K|M|G|T|P)?$/i;
      const hasTimetable = value.includes(',') || value.includes('-') || value.includes(':');
      return !simpleBandwidth.test(value) && !hasTimetable && value.length > 0
        ? { bwTimetable: { value, message: 'Invalid bandwidth format' } }
        : null;
    };
  }

  private fileModeValidator(defaultValue?: string): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim();
      if (defaultValue && value.toLowerCase() === defaultValue.toLowerCase()) return null;
      return !/^[0-7]{3,4}$/.test(value)
        ? {
            fileMode: {
              value,
              message: 'Must be octal format (3-4 digits, each 0-7). Example: 755',
            },
          }
        : null;
    };
  }

  private enumValidator(allowedValues: string[]): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      if (!control.value || control.value === '') return null;
      const value = control.value.toString().trim().toLowerCase();
      const allowed = allowedValues.map(v => v.toLowerCase());
      return !allowed.includes(value)
        ? { enum: { value, allowedValues, message: `Must be one of: ${allowedValues.join(', ')}` } }
        : null;
    };
  }

  getRCloneOptionError(control: AbstractControl | null): string | null {
    if (!control || !control.errors) return null;
    const errors = control.errors;
    return (
      errors['required']?.message ||
      errors['integer']?.message ||
      errors['float']?.message ||
      errors['duration']?.message ||
      errors['sizeSuffix']?.message ||
      errors['bwTimetable']?.message ||
      errors['fileMode']?.message ||
      errors['enum']?.message ||
      'Invalid value'
    );
  }

  // UI helpers
  getPageTitle(): string {
    if (this.currentPage === 'home') return 'RClone Configuration';
    if (this.currentPage === 'security') return 'Security Settings';
    if (this.currentCategory) {
      return `${this.currentPage.toUpperCase()} - ${this.currentCategory}`;
    }
    return 'Backend Settings';
  }

  trackByIndex(index: number): number {
    return index;
  }

  trackByOptionName(_index?: number, option?: RcConfigOption): string {
    return `${this.currentPage}-${this.currentCategory}-${option?.Name}`;
  }

  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    this.dialogRef.close();
  }
}
