import { CommonModule } from '@angular/common';
import {
  Component,
  HostListener,
  OnInit,
  inject,
  ChangeDetectorRef,
  OnDestroy,
  ViewChild,
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
  AbstractControl,
  FormGroup,
} from '@angular/forms';
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

import { AnimationsService } from '../../../../shared/services/animations.service';
import { FlagConfigService, RcloneBackendOptionsService } from '@app/services';
import { NotificationService } from '../../../../shared/services/notification.service';
import { RcConfigOption } from '@app/types';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { SecuritySettingsComponent } from '../security-settings/security-settings.component';
import { distinctUntilChanged, Subject, takeUntil } from 'rxjs';
import { SettingControlComponent } from 'src/app/shared/components';

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
    ScrollingModule,
    SearchContainerComponent,
    SecuritySettingsComponent,
    SettingControlComponent,
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

  // --- View Child for Virtual Scroll ---
  @ViewChild(CdkVirtualScrollViewport) virtualScrollViewport?: CdkVirtualScrollViewport;
  @ViewChild('searchViewport') searchViewport?: CdkVirtualScrollViewport;

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
  private optionIsDefaultMap = new Map<string, boolean>();

  // Virtual scroll properties
  virtualScrollData: RcConfigOption[] = [];

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
    this.setupSearchSubscription();
  }

  private setupSearchSubscription(): void {
    this.search$
      .pipe(distinctUntilChanged(), takeUntil(this.componentDestroyed$))
      .subscribe(searchText => {
        const query = searchText.toLowerCase().trim();
        this.searchQuery = query;

        if (this.currentPage === 'home') {
          if (!query) {
            this.globalSearchResults = [];
            this.filteredServices = [...this.services].map(s => ({ ...s, expanded: false }));
          } else {
            this.performGlobalSearch(query);
            this.updateFilteredServices();
          }
        } else if (this.currentPage !== 'home' && this.currentPage !== 'security') {
          this.updateVirtualScrollData();
        }

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

  onOptionValueChanged(optionName: string, isChanged: boolean): void {
    this.optionIsDefaultMap.set(optionName, !isChanged);
    this.cdRef.detectChanges();
  }

  isOptionAtDefault(optionName: string): boolean {
    return this.optionIsDefaultMap.get(optionName) ?? true;
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
          this.rcloneOptionsForm.addControl(uniqueControlKey, new FormControl(option.Value));
        }
      }
    }
  }

  // Virtual Scroll Methods
  private updateVirtualScrollData(): void {
    this.virtualScrollData = this.getRCloneOptionsForCurrentPage();
    this.cdRef.detectChanges();

    setTimeout(() => {
      this.virtualScrollViewport?.scrollToIndex(0);
    }, 0);
  }

  getVirtualScrollData(): RcConfigOption[] {
    return this.virtualScrollData;
  }

  trackByOptionIndex(index: number, option: RcConfigOption): string {
    return `${this.currentPage}-${this.currentCategory}-${option.Name}-${index}`;
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

    if (this.currentPage !== 'home' && this.currentPage !== 'security') {
      this.updateVirtualScrollData();
    }

    this.cdRef.detectChanges();

    const option = this.optionToFocus;
    if (option) {
      setTimeout(() => {
        this.scrollToOption(option);
      }, 100);
    }
  }

  private scrollToOption(optionName: string): void {
    if (this.virtualScrollViewport && this.virtualScrollData.length > 0) {
      const index = this.virtualScrollData.findIndex(opt => opt.Name === optionName);
      if (index !== -1) {
        this.virtualScrollViewport.scrollToIndex(index, 'smooth');
      }
    }
    this.optionToFocus = null;
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
    this.cdRef.detectChanges();
  }

  private updateFilteredServices(): void {
    this.searchMatchCounts.clear();

    if (this.globalSearchResults.length > 0) {
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
    this.cdRef.detectChanges();
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

  async saveRCloneOption(optionName: string, isAtDefault: boolean): Promise<void> {
    const control = this.rcloneOptionsForm.get(optionName);
    console.log('Saving option:', optionName, 'with value:', control?.value);

    if (!control || control.invalid || this.savingOptions.has(optionName) || control.pristine) {
      console.log('Skipping save for option:', optionName);
      return;
    }

    try {
      this.savingOptions.add(optionName);
      control.disable({ emitEvent: false });

      const service = this.optionToServiceMap[optionName];
      const fullFieldName = this.optionToFullFieldNameMap[optionName];

      if (!service || !fullFieldName) {
        throw new Error(`Mapping not found for ${optionName}`);
      }

      let valueToSave = control.value;
      if (Array.isArray(valueToSave)) {
        valueToSave = valueToSave.filter(v => v);
      }

      if (isAtDefault) {
        // Value is at default - remove from JSON file
        await this.rcloneBackendOptionsService.removeOption(service, fullFieldName);
        this.notificationService.showSuccess(`Reset to default: ${fullFieldName}`);
      } else {
        // Value is custom - save to JSON file
        await this.rcloneBackendOptionsService.saveOption(service, fullFieldName, valueToSave);
        this.notificationService.showSuccess(`Saved: ${fullFieldName}`);
      }
      await this.flagConfigService.saveOption(service, fullFieldName, valueToSave);

      control.markAsPristine();
    } catch (error) {
      console.error(`Failed to save option ${optionName}:`, error);
      this.notificationService.showError(`Failed to save ${optionName}: ${error as string}`);
    } finally {
      this.savingOptions.delete(optionName);
      if (control) {
        control.enable({ emitEvent: false });
      }
      this.cdRef.detectChanges();
    }
  }

  getRCloneOptionControl(optionName: string): AbstractControl | null {
    const uniqueKey = `${this.currentPage}---${this.currentCategory}---${optionName}`;
    return this.rcloneOptionsForm.get(uniqueKey);
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
    if (typeof _index === 'number') {
      return `${this.currentPage}-${this.currentCategory}-${option?.Name}-${_index}`;
    }
    return `${this.currentPage}-${this.currentCategory}-${option?.Name}`;
  }

  public getUniqueControlKey(option: RcConfigOption): string {
    return `${this.currentPage}---${this.currentCategory}---${option.Name}`;
  }

  @HostListener('document:keydown.escape', ['$event'])
  close(): void {
    this.dialogRef.close();
  }
}
