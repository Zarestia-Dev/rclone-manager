import { CommonModule } from '@angular/common';
import {
  Component,
  HostListener,
  OnInit,
  inject,
  OnDestroy,
  ViewChild,
  signal,
  computed,
  effect,
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
  FormGroup,
  FormBuilder,
} from '@angular/forms';
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

import { FlagConfigService, RcloneBackendOptionsService } from '@app/services';
import { NotificationService } from '../../../../shared/services/notification.service';
import { RcConfigOption } from '@app/types';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { SecuritySettingsComponent } from '../security-settings/security-settings.component';
import { distinctUntilChanged, Subject, takeUntil, debounceTime } from 'rxjs';
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
  styleUrls: ['./rclone-config-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class RcloneConfigModalComponent implements OnInit, OnDestroy {
  // --- Injected Services & DialogRef ---
  private dialogRef = inject(MatDialogRef<RcloneConfigModalComponent>);
  private notificationService = inject(NotificationService);
  private flagConfigService = inject(FlagConfigService);
  private rcloneBackendOptionsService = inject(RcloneBackendOptionsService);
  private fb = inject(FormBuilder);

  // --- View Child for Virtual Scroll ---
  @ViewChild(CdkVirtualScrollViewport) virtualScrollViewport?: CdkVirtualScrollViewport;

  // --- Signals ---
  currentPage = signal<PageType>('home');
  currentCategory = signal<string | null>(null);
  isLoading = signal(true);
  searchQuery = signal('');
  isSearchVisible = signal(false);
  savingOptions = signal(new Set<string>());
  
  // Services and filtering
  services = signal<RCloneService[]>([]);
  filteredServices = signal<RCloneService[]>([]);
  globalSearchResults = signal<SearchResult[]>([]);
  searchMatchCounts = signal(new Map<string, number>());
  virtualScrollData = signal<RcConfigOption[]>([]);
  
  // Option state tracking
  private optionIsDefaultMap = signal(new Map<string, boolean>());

  // Form
  rcloneOptionsForm: FormGroup;

  // --- Computed Signals ---
  hasSearchQuery = computed(() => this.searchQuery().trim().length > 0);
  
  isSecurityPage = computed(() => this.currentPage() === 'security');
  
  filteredOptionsCount = computed(() => {
    const page = this.currentPage();
    const category = this.currentCategory();
    if (page === 'home' || page === 'security' || !category) {
      return 0;
    }
    return this.virtualScrollData().length;
  });
  
  totalOptionsCount = computed(() => {
    const page = this.currentPage();
    const category = this.currentCategory();
    if (page === 'home' || page === 'security' || !category) {
      return 0;
    }
    return (this.groupedRcloneOptions[page]?.[category] || []).length;
  });

  servicesByMainCategory = computed(() => {
    const grouped: Record<string, RCloneService[]> = {
      'General Settings': [],
      'File System & Storage': [],
      'Network & Servers': [],
    };

    this.filteredServices().forEach(service => {
      const mainCategory = this.serviceCategoryMap[service.name] || 'Network & Servers';
      if (grouped[mainCategory]) {
        grouped[mainCategory].push(service);
      }
    });

    return grouped;
  });

  // --- Private Properties ---
  private readonly componentDestroyed$ = new Subject<void>();
  private readonly search$ = new Subject<string>();
  private groupedRcloneOptions: GroupedRCloneOptions = {};
  private optionToFocus: string | null = null;
  private optionToServiceMap: Record<string, string> = {};
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

  private readonly categoryIconMap: Record<string, string> = {
    General: 'gear',
    Auth: 'lock',
    HTTP: 'globe',
    Template: 'terminal',
    MetaRules: 'chart',
    RulesOpt: 'filter',
    MetricsAuth: 'lock',
    MetricsHTTP: 'globe',
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
    this.rcloneOptionsForm = this.fb.group({});
    this.setupSearchSubscription();
    this.setupVirtualScrollEffect();
  }

  private setupSearchSubscription(): void {
    this.search$
      .pipe(
        distinctUntilChanged(),
        debounceTime(200),
        takeUntil(this.componentDestroyed$)
      )
      .subscribe(searchText => {
        const query = searchText.toLowerCase().trim();
        this.searchQuery.set(query);

        if (this.currentPage() === 'home') {
          if (!query) {
            this.globalSearchResults.set([]);
            this.filteredServices.set([...this.services()].map(s => ({ ...s, expanded: false })));
          } else {
            this.performGlobalSearch(query);
            this.updateFilteredServices();
          }
        } else if (this.currentPage() !== 'home' && this.currentPage() !== 'security') {
          this.updateVirtualScrollData();
        }
      });
  }

  private setupVirtualScrollEffect(): void {
    // Effect to scroll to top when virtual scroll data changes
    effect(() => {
      const data = this.virtualScrollData();
      if (data.length > 0) {
        setTimeout(() => {
          this.virtualScrollViewport?.scrollToIndex(0);
        }, 0);
      }
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
    return this.currentPage() === 'home'
      ? 'Search all services and settings...'
      : `Search in ${this.currentPage().toUpperCase()}...`;
  }

  getMatchCountForCategory(serviceName: string, categoryName: string): number {
    const key = `${serviceName}---${categoryName}`;
    return this.searchMatchCounts().get(key) || 0;
  }

  async ngOnInit(): Promise<void> {
    await this.loadAndBuildOptions();
    this.isLoading.set(false);
  }

  onOptionValueChanged(optionName: string, isChanged: boolean): void {
    const currentMap = this.optionIsDefaultMap();
    const newMap = new Map(currentMap);
    newMap.set(optionName, !isChanged);
    this.optionIsDefaultMap.set(newMap);
  }

  isOptionAtDefault(optionName: string): boolean {
    return this.optionIsDefaultMap().get(optionName) ?? true;
  }

  private async loadAndBuildOptions(): Promise<void> {
    try {
      this.groupedRcloneOptions = await this.flagConfigService.getGroupedOptions();
      this.buildServices();
      this.createRCloneOptionControls();
    } catch (error) {
      console.error('Failed to load RClone configuration:', error);
      this.notificationService.showError('Failed to load RClone configuration');
    }
  }

  private buildServices(): void {
    const servicesList = Object.keys(this.groupedRcloneOptions).map(serviceName => ({
      name: serviceName,
      expanded: false,
      categories: Object.keys(this.groupedRcloneOptions[serviceName]),
    }));
    this.services.set(servicesList);
    this.filteredServices.set([...servicesList]);
  }

  private createRCloneOptionControls(): void {
    const controls: Record<string, FormControl> = {};

    for (const service in this.groupedRcloneOptions) {
      for (const category in this.groupedRcloneOptions[service]) {
        for (const option of this.groupedRcloneOptions[service][category]) {
          const fullFieldName =
            category === 'General' ? option.FieldName : `${category}.${option.FieldName}`;
          const uniqueControlKey = `${service}---${category}---${option.Name}`;

          this.optionToServiceMap[uniqueControlKey] = service;
          this.optionToFullFieldNameMap[uniqueControlKey] = fullFieldName;
          controls[uniqueControlKey] = this.fb.control(option.Value);
        }
      }
    }

    this.rcloneOptionsForm = this.fb.group(controls);
  }

  // Virtual Scroll Methods
  private updateVirtualScrollData(): void {
    this.virtualScrollData.set(this.getRCloneOptionsForCurrentPage());
  }

  trackByOptionIndex(index: number, option: RcConfigOption): string {
    // Include index to handle options with duplicate Names across different services/categories
    return `${index}-${option.Name}`;
  }

  trackBySearchResult(_index: number, result: SearchResult): string {
    return `${result.service}-${result.category}-${result.option.Name}`;
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
    return this.categoryIconMap[categoryName] || 'gear';
  }

  getCategoryDescription(categoryName: string): string {
    return this.categoryDescriptionMap[categoryName] || '';
  }

  // Navigation and page management
  navigateTo(service: string, category?: string, optionName?: string): void {
    if (service === 'security') {
      this.currentPage.set('security');
      this.currentCategory.set(null);
    } else {
      this.currentPage.set(service);
      this.currentCategory.set(category || null);
    }

    this.optionToFocus = optionName || null;

    if (this.currentPage() !== 'home' && this.currentPage() !== 'security') {
      this.updateVirtualScrollData();
    }

    const option = this.optionToFocus;
    if (option) {
      setTimeout(() => {
        this.scrollToOption(option);
      }, 100);
    }
  }

  handleKeyboardNavigation(event: KeyboardEvent, service: string, category?: string, optionName?: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.navigateTo(service, category, optionName);
    }
  }

  private scrollToOption(optionName: string): void {
    if (this.virtualScrollViewport && this.virtualScrollData().length > 0) {
      const index = this.virtualScrollData().findIndex(opt => opt.Name === optionName);
      if (index !== -1) {
        this.virtualScrollViewport.scrollToIndex(index, 'smooth');
      }
    }
    this.optionToFocus = null;
  }

  getRCloneOptionsForCurrentPage(): RcConfigOption[] {
    const page = this.currentPage();
    const category = this.currentCategory();
    
    if (page === 'home' || page === 'security' || !category) {
      return [];
    }

    const options = this.groupedRcloneOptions[page]?.[category] || [];
    return this.filterOptionsBySearch(options);
  }

  private filterOptionsBySearch(options: RcConfigOption[]): RcConfigOption[] {
    const query = this.searchQuery();
    if (!query || query.trim() === '') return options;

    const lowerQuery = query.toLowerCase().trim();
    return options.filter(
      option =>
        option.Name.toLowerCase().includes(lowerQuery) ||
        option.FieldName.toLowerCase().includes(lowerQuery) ||
        option.Help.toLowerCase().includes(lowerQuery)
    );
  }

  private performGlobalSearch(query: string): void {
    const results: SearchResult[] = [];
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
            results.push({ service, category, option });
          }
        }
      }
    }
    this.globalSearchResults.set(results);
  }

  private updateFilteredServices(): void {
    const newMatchCounts = new Map<string, number>();
    const results = this.globalSearchResults();

    if (results.length > 0) {
      results.forEach(result => {
        const key = `${result.service}---${result.category}`;
        const currentCount = newMatchCounts.get(key) || 0;
        newMatchCounts.set(key, currentCount + 1);
      });

      const servicesWithMatches = new Set(results.map(r => r.service));
      const filtered = this.services()
        .filter(svc => servicesWithMatches.has(svc.name))
        .map(svc => ({ ...svc, expanded: true }));
      
      this.filteredServices.set(filtered);
    } else {
      const query = this.searchQuery().toLowerCase().trim();
      const filtered = this.services()
        .filter(
          svc =>
            svc.name.toLowerCase().includes(query) ||
            (this.serviceDescriptionMap[svc.name] || '').toLowerCase().includes(query)
        )
        .map(svc => ({ ...svc, expanded: true }));
      
      this.filteredServices.set(filtered);
    }
    
    this.searchMatchCounts.set(newMatchCounts);
  }

  toggleSearchVisibility(): void {
    this.isSearchVisible.update(visible => !visible);
    if (!this.isSearchVisible()) {
      this.searchQuery.set('');
      this.onSearchInput('');
    }
  }

  async saveRCloneOption(optionName: string, isAtDefault: boolean): Promise<void> {
    const control = this.rcloneOptionsForm.get(optionName);

    if (!control || control.invalid || this.savingOptions().has(optionName) || control.pristine) {
      return;
    }

    try {
      const currentSaving = new Set(this.savingOptions());
      currentSaving.add(optionName);
      this.savingOptions.set(currentSaving);
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
        await this.rcloneBackendOptionsService.removeOption(service, fullFieldName);
        this.notificationService.showSuccess(`Reset to default: ${fullFieldName}`);
      } else {
        await this.rcloneBackendOptionsService.saveOption(service, fullFieldName, valueToSave);
        this.notificationService.showSuccess(`Saved: ${fullFieldName}`);
      }
      await this.flagConfigService.saveOption(service, fullFieldName, valueToSave);

      control.markAsPristine();
    } catch (error) {
      console.error(`Failed to save option ${optionName}:`, error);
      this.notificationService.showError(`Failed to save ${optionName}: ${error as string}`);
    } finally {
      const currentSaving = new Set(this.savingOptions());
      currentSaving.delete(optionName);
      this.savingOptions.set(currentSaving);
      if (control) {
        control.enable({ emitEvent: false });
      }
    }
  }

  // UI helpers
  getPageTitle(): string {
    const page = this.currentPage();
    const category = this.currentCategory();
    
    if (page === 'home') return 'RClone Configuration';
    if (page === 'security') return 'Security Settings';
    if (category) {
      return `${page.toUpperCase()} - ${category}`;
    }
    return 'Backend Settings';
  }

  public getUniqueControlKey(option: RcConfigOption): string {
    return `${this.currentPage()}---${this.currentCategory()}---${option.Name}`;
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.dialogRef.close();
  }
}