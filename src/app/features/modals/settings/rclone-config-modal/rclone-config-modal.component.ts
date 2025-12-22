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
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { distinctUntilChanged, Subject, takeUntil, debounceTime } from 'rxjs';

import { FlagConfigService, RcloneBackendOptionsService } from '@app/services';
import { NotificationService } from '../../../../shared/services/notification.service';
import { RcConfigOption } from '@app/types';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { SecuritySettingsComponent } from '../security-settings/security-settings.component';
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

// Consolidated service configuration
interface ServiceConfig {
  icon: string;
  description: string;
  mainCategory: string;
}

const SERVICE_CONFIG: Record<string, ServiceConfig> = {
  vfs: {
    icon: 'vfs',
    description: 'Virtual File System caching and performance settings',
    mainCategory: 'File System & Storage',
  },
  mount: {
    icon: 'mount',
    description: 'Mount-specific options and FUSE configuration',
    mainCategory: 'File System & Storage',
  },
  filter: {
    icon: 'filter',
    description: 'File filtering rules and patterns',
    mainCategory: 'File System & Storage',
  },
  main: {
    icon: 'gear',
    description: 'General RClone operation and transfer settings',
    mainCategory: 'General Settings',
  },
  log: {
    icon: 'file-lines',
    description: 'Logging configuration and output settings',
    mainCategory: 'General Settings',
  },
  http: { icon: 'globe', description: 'HTTP server settings', mainCategory: 'Network & Servers' },
  rc: {
    icon: 'server',
    description: 'Remote control server configuration',
    mainCategory: 'General Settings',
  },
  dlna: { icon: 'tv', description: 'DLNA server settings', mainCategory: 'Network & Servers' },
  ftp: {
    icon: 'file-arrow-up',
    description: 'FTP server configuration',
    mainCategory: 'Network & Servers',
  },
  nfs: { icon: 'database', description: 'NFS server settings', mainCategory: 'Network & Servers' },
  proxy: {
    icon: 'shield-halved',
    description: 'Proxy authentication settings',
    mainCategory: 'General Settings',
  },
  restic: {
    icon: 'box-archive',
    description: 'Restic server configuration',
    mainCategory: 'Network & Servers',
  },
  s3: { icon: 'bucket', description: 'S3 server settings', mainCategory: 'Network & Servers' },
  sftp: {
    icon: 'lock',
    description: 'SFTP server configuration',
    mainCategory: 'Network & Servers',
  },
  webdav: {
    icon: 'cloud',
    description: 'WebDAV server settings',
    mainCategory: 'Network & Servers',
  },
};

const CATEGORY_CONFIG: Record<string, { icon: string; description: string }> = {
  General: { icon: 'gear', description: 'General configuration options' },
  Auth: { icon: 'lock', description: 'Authentication and credentials' },
  HTTP: { icon: 'globe', description: 'HTTP-specific settings' },
  Template: { icon: 'terminal', description: 'Template settings' },
  MetaRules: { icon: 'chart', description: 'Meta rule configurations' },
  RulesOpt: { icon: 'filter', description: 'Rule options' },
  MetricsAuth: { icon: 'lock', description: 'Metrics authentication' },
  MetricsHTTP: { icon: 'globe', description: 'Metrics HTTP settings' },
};

const MAIN_CATEGORY_CONFIG: Record<string, { icon: string; description: string }> = {
  'General Settings': {
    icon: 'gear',
    description: 'Core RClone options and logging configuration',
  },
  'File System & Storage': {
    icon: 'folder',
    description: 'Virtual file system, mounting, filtering, and storage options',
  },
  'Network & Servers': {
    icon: 'public',
    description: 'HTTP, FTP, SFTP, WebDAV, S3, and other network service settings',
  },
};

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
  private dialogRef = inject(MatDialogRef<RcloneConfigModalComponent>);
  private notificationService = inject(NotificationService);
  private flagConfigService = inject(FlagConfigService);
  private rcloneBackendOptionsService = inject(RcloneBackendOptionsService);
  private fb = inject(FormBuilder);

  @ViewChild(CdkVirtualScrollViewport) virtualScrollViewport?: CdkVirtualScrollViewport;

  // Signals
  currentPage = signal<PageType>('home');
  currentCategory = signal<string | null>(null);
  isLoading = signal(true);
  searchQuery = signal('');
  isSearchVisible = signal(false);
  savingOptions = signal(new Set<string>());
  services = signal<RCloneService[]>([]);
  filteredServices = signal<RCloneService[]>([]);
  globalSearchResults = signal<SearchResult[]>([]);
  searchMatchCounts = signal(new Map<string, number>());
  virtualScrollData = signal<RcConfigOption[]>([]);
  private optionIsDefaultMap = signal(new Map<string, boolean>());

  // Form
  rcloneOptionsForm: FormGroup;

  // Computed
  hasSearchQuery = computed(() => this.searchQuery().trim().length > 0);
  isSecurityPage = computed(() => this.currentPage() === 'security');

  filteredOptionsCount = computed(() => {
    const page = this.currentPage();
    if (page === 'home' || page === 'security' || !this.currentCategory()) return 0;
    return this.virtualScrollData().length;
  });

  totalOptionsCount = computed(() => {
    const page = this.currentPage();
    const category = this.currentCategory();
    if (page === 'home' || page === 'security' || !category) return 0;
    return (this.groupedRcloneOptions[page]?.[category] || []).length;
  });

  servicesByMainCategory = computed(() => {
    const grouped: Record<string, RCloneService[]> = {
      'General Settings': [],
      'File System & Storage': [],
      'Network & Servers': [],
    };

    this.filteredServices().forEach(service => {
      const mainCategory = SERVICE_CONFIG[service.name]?.mainCategory || 'Network & Servers';
      grouped[mainCategory]?.push(service);
    });

    return grouped;
  });

  // Private
  private readonly componentDestroyed$ = new Subject<void>();
  private readonly search$ = new Subject<string>();
  private groupedRcloneOptions: GroupedRCloneOptions = {};
  private optionToFocus: string | null = null;
  private optionToServiceMap: Record<string, string> = {};
  private optionToFullFieldNameMap: Record<string, string> = {};

  constructor() {
    this.rcloneOptionsForm = this.fb.group({});
    this.setupSearchSubscription();
    this.setupVirtualScrollEffect();
  }

  private setupSearchSubscription(): void {
    this.search$
      .pipe(distinctUntilChanged(), debounceTime(200), takeUntil(this.componentDestroyed$))
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
        } else if (this.currentPage() !== 'security') {
          this.updateVirtualScrollData();
        }
      });
  }

  private setupVirtualScrollEffect(): void {
    effect(() => {
      if (this.virtualScrollData().length > 0) {
        setTimeout(() => this.virtualScrollViewport?.scrollToIndex(0), 0);
      }
    });
  }

  ngOnDestroy(): void {
    this.componentDestroyed$.next();
    this.componentDestroyed$.complete();
  }

  async ngOnInit(): Promise<void> {
    await this.loadAndBuildOptions();
    this.isLoading.set(false);
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
    return this.searchMatchCounts().get(`${serviceName}---${categoryName}`) || 0;
  }

  onOptionValueChanged(optionName: string, isChanged: boolean): void {
    const newMap = new Map(this.optionIsDefaultMap());
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
    const servicesList = Object.keys(this.groupedRcloneOptions).map(name => ({
      name,
      expanded: false,
      categories: Object.keys(this.groupedRcloneOptions[name]),
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

  private updateVirtualScrollData(): void {
    this.virtualScrollData.set(this.getRCloneOptionsForCurrentPage());
  }

  trackByOptionIndex(index: number, option: RcConfigOption): string {
    return `${index}-${option.Name}`;
  }

  trackBySearchResult(_index: number, result: SearchResult): string {
    return `${result.service}-${result.category}-${result.option.Name}`;
  }

  // Config accessors using consolidated maps
  getServiceIcon(name: string): string {
    return SERVICE_CONFIG[name]?.icon ?? 'gear';
  }

  getServiceDescription(name: string): string {
    return SERVICE_CONFIG[name]?.description ?? '';
  }

  getServiceCategories(name: string): string[] {
    return this.groupedRcloneOptions[name] ? Object.keys(this.groupedRcloneOptions[name]) : [];
  }

  getCategoryIcon(name: string): string {
    return CATEGORY_CONFIG[name]?.icon ?? 'gear';
  }

  getCategoryDescription(name: string): string {
    return CATEGORY_CONFIG[name]?.description ?? '';
  }

  getMainCategoryIcon(name: string): string {
    return MAIN_CATEGORY_CONFIG[name]?.icon ?? 'gear';
  }

  getMainCategoryDescription(name: string): string {
    return MAIN_CATEGORY_CONFIG[name]?.description ?? '';
  }

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

    if (this.optionToFocus) {
      setTimeout(() => this.scrollToOption(this.optionToFocus!), 100);
    }
  }

  handleKeyboardNavigation(
    event: KeyboardEvent,
    service: string,
    category?: string,
    optionName?: string
  ): void {
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
    if (page === 'home' || page === 'security' || !category) return [];

    const options = this.groupedRcloneOptions[page]?.[category] || [];
    return this.filterOptionsBySearch(options);
  }

  private filterOptionsBySearch(options: RcConfigOption[]): RcConfigOption[] {
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) return options;

    return options.filter(
      opt =>
        opt.Name.toLowerCase().includes(query) ||
        opt.FieldName.toLowerCase().includes(query) ||
        opt.Help.toLowerCase().includes(query)
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
        newMatchCounts.set(key, (newMatchCounts.get(key) || 0) + 1);
      });

      const servicesWithMatches = new Set(results.map(r => r.service));
      this.filteredServices.set(
        this.services()
          .filter(svc => servicesWithMatches.has(svc.name))
          .map(svc => ({ ...svc, expanded: true }))
      );
    } else {
      const query = this.searchQuery().toLowerCase().trim();
      this.filteredServices.set(
        this.services()
          .filter(
            svc =>
              svc.name.toLowerCase().includes(query) ||
              (SERVICE_CONFIG[svc.name]?.description || '').toLowerCase().includes(query)
          )
          .map(svc => ({ ...svc, expanded: true }))
      );
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
      control?.enable({ emitEvent: false });
    }
  }

  getPageTitle(): string {
    const page = this.currentPage();
    const category = this.currentCategory();
    if (page === 'home') return 'RClone Configuration';
    if (page === 'security') return 'Security Settings';
    if (category) return `${page.toUpperCase()} - ${category}`;
    return 'Backend Settings';
  }

  getUniqueControlKey(option: RcConfigOption): string {
    return `${this.currentPage()}---${this.currentCategory()}---${option.Name}`;
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.dialogRef.close();
  }
}
