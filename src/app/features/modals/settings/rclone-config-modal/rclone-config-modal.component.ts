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
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatDialogRef, MatDialog } from '@angular/material/dialog';
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
import { distinctUntilChanged, Subject, takeUntil, debounceTime, firstValueFrom } from 'rxjs';

import { FlagConfigService, RcloneBackendOptionsService } from '@app/services';
import { NotificationService } from '@app/services';
import { RcConfigOption } from '@app/types';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { SettingControlComponent } from 'src/app/shared/components';
import { ConfirmModalComponent } from 'src/app/shared/modals/confirm-modal/confirm-modal.component';

type PageType = 'home' | string;
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
    description: 'modals.rcloneConfig.services.vfs',
    mainCategory: 'File System & Storage',
  },
  mount: {
    icon: 'mount',
    description: 'modals.rcloneConfig.services.mount',
    mainCategory: 'File System & Storage',
  },
  filter: {
    icon: 'filter',
    description: 'modals.rcloneConfig.services.filter',
    mainCategory: 'File System & Storage',
  },
  main: {
    icon: 'gear',
    description: 'modals.rcloneConfig.services.main',
    mainCategory: 'General Settings',
  },
  log: {
    icon: 'file-lines',
    description: 'modals.rcloneConfig.services.log',
    mainCategory: 'General Settings',
  },
  http: {
    icon: 'globe',
    description: 'modals.rcloneConfig.services.http',
    mainCategory: 'Network & Servers',
  },
  rc: {
    icon: 'server',
    description: 'modals.rcloneConfig.services.rc',
    mainCategory: 'General Settings',
  },
  dlna: {
    icon: 'tv',
    description: 'modals.rcloneConfig.services.dlna',
    mainCategory: 'Network & Servers',
  },
  ftp: {
    icon: 'file-arrow-up',
    description: 'modals.rcloneConfig.services.ftp',
    mainCategory: 'Network & Servers',
  },
  nfs: {
    icon: 'database',
    description: 'modals.rcloneConfig.services.nfs',
    mainCategory: 'Network & Servers',
  },
  proxy: {
    icon: 'shield-halved',
    description: 'modals.rcloneConfig.services.proxy',
    mainCategory: 'General Settings',
  },
  restic: {
    icon: 'box-archive',
    description: 'modals.rcloneConfig.services.restic',
    mainCategory: 'Network & Servers',
  },
  s3: {
    icon: 'bucket',
    description: 'modals.rcloneConfig.services.s3',
    mainCategory: 'Network & Servers',
  },
  sftp: {
    icon: 'lock',
    description: 'modals.rcloneConfig.services.sftp',
    mainCategory: 'Network & Servers',
  },
  webdav: {
    icon: 'cloud',
    description: 'modals.rcloneConfig.services.webdav',
    mainCategory: 'Network & Servers',
  },
};

const CATEGORY_CONFIG: Record<string, { icon: string; description: string }> = {
  General: { icon: 'gear', description: 'modals.rcloneConfig.categories.General' },
  Auth: { icon: 'lock', description: 'modals.rcloneConfig.categories.Auth' },
  HTTP: { icon: 'globe', description: 'modals.rcloneConfig.categories.HTTP' },
  Template: { icon: 'terminal', description: 'modals.rcloneConfig.categories.Template' },
  MetaRules: { icon: 'chart', description: 'modals.rcloneConfig.categories.MetaRules' },
  RulesOpt: { icon: 'filter', description: 'modals.rcloneConfig.categories.RulesOpt' },
  MetricsAuth: { icon: 'lock', description: 'modals.rcloneConfig.categories.MetricsAuth' },
  MetricsHTTP: { icon: 'globe', description: 'modals.rcloneConfig.categories.MetricsHTTP' },
};

const MAIN_CATEGORY_CONFIG: Record<
  string,
  { icon: string; description: string; titleKey: string }
> = {
  'General Settings': {
    icon: 'gear',
    description: 'modals.rcloneConfig.mainCategories.generalSettings.description',
    titleKey: 'modals.rcloneConfig.mainCategories.generalSettings.title',
  },
  'File System & Storage': {
    icon: 'folder',
    description: 'modals.rcloneConfig.mainCategories.fileSystemAndStorage.description',
    titleKey: 'modals.rcloneConfig.mainCategories.fileSystemAndStorage.title',
  },
  'Network & Servers': {
    icon: 'public',
    description: 'modals.rcloneConfig.mainCategories.networkAndServers.description',
    titleKey: 'modals.rcloneConfig.mainCategories.networkAndServers.title',
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
    SettingControlComponent,
    TranslateModule,
  ],
  templateUrl: './rclone-config-modal.component.html',
  styleUrls: ['./rclone-config-modal.component.scss', '../../../../styles/_shared-modal.scss'],
})
export class RcloneConfigModalComponent implements OnInit, OnDestroy {
  private dialogRef = inject(MatDialogRef<RcloneConfigModalComponent>);
  private notificationService = inject(NotificationService);
  private flagConfigService = inject(FlagConfigService);
  private rcloneBackendOptionsService = inject(RcloneBackendOptionsService);
  private dialog = inject(MatDialog);
  private fb = inject(FormBuilder);
  private translate = inject(TranslateService);

  @ViewChild(CdkVirtualScrollViewport) virtualScrollViewport?: CdkVirtualScrollViewport;

  // Signals
  currentPage = signal<PageType>('home');
  currentCategory = signal<string | null>(null);
  isLoading = signal(true);
  searchQuery = signal('');
  isSearchVisible = signal(false);
  savingOptions = signal(new Set<string>());
  isResetting = signal(false);
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

  filteredOptionsCount = computed(() => {
    const page = this.currentPage();
    if (page === 'home' || !this.currentCategory()) return 0;
    return this.virtualScrollData().length;
  });

  totalOptionsCount = computed(() => {
    const page = this.currentPage();
    const category = this.currentCategory();
    if (page === 'home' || !category) return 0;
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
        } else {
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
      ? 'modals.rcloneConfig.search.placeholderHome'
      : 'modals.rcloneConfig.search.placeholderPage';
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
      this.notificationService.showError(
        this.translate.instant('modals.rcloneConfig.notifications.loadError')
      );
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

  getMainCategoryTitle(name: string): string {
    return MAIN_CATEGORY_CONFIG[name]?.titleKey ?? name;
  }

  getMainCategoryDescription(name: string): string {
    return MAIN_CATEGORY_CONFIG[name]?.description ?? '';
  }

  navigateTo(service: string, category?: string, optionName?: string): void {
    this.currentPage.set(service);
    this.currentCategory.set(category || null);

    this.optionToFocus = optionName || null;

    if (this.currentPage() !== 'home') {
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
    if (page === 'home' || !category) return [];

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
        this.notificationService.showSuccess(
          this.translate.instant('modals.rcloneConfig.notifications.resetSuccess', {
            field: fullFieldName,
          })
        );
      } else {
        await this.rcloneBackendOptionsService.saveOption(service, fullFieldName, valueToSave);
        this.notificationService.showSuccess(
          this.translate.instant('modals.rcloneConfig.notifications.saveSuccess', {
            field: fullFieldName,
          })
        );
      }
      await this.flagConfigService.saveOption(service, fullFieldName, valueToSave);

      control.markAsPristine();
    } catch (error) {
      console.error(`Failed to save option ${optionName}:`, error);
      this.notificationService.showError(
        this.translate.instant('modals.rcloneConfig.notifications.saveError', {
          field: optionName,
          error: error as string,
        })
      );
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
    if (category) return `${page.toUpperCase()} - ${category}`;
    return 'Backend Settings';
  }

  getUniqueControlKey(option: RcConfigOption): string {
    return `${this.currentPage()}---${this.currentCategory()}---${option.Name}`;
  }

  async resetAllOptions(): Promise<void> {
    // Show confirmation dialog
    const dialogRef = this.dialog.open(ConfirmModalComponent, {
      data: {
        title: this.translate.instant('modals.rcloneConfig.reset.title'),
        message: this.translate.instant('modals.rcloneConfig.reset.message'),
        confirmText: this.translate.instant('modals.rcloneConfig.reset.confirm'),
        cancelText: this.translate.instant('common.cancel'),
      },
    });

    const confirmed = await firstValueFrom(dialogRef.afterClosed());
    if (!confirmed) return;

    this.isResetting.set(true);
    try {
      // Backend now handles both: delete file + restart engine
      await this.rcloneBackendOptionsService.resetOptions();

      // Reload options to refresh the form with defaults
      await this.loadAndBuildOptions();

      this.notificationService.showSuccess(
        this.translate.instant('modals.rcloneConfig.notifications.resetAllSuccess')
      );
    } catch (error) {
      console.error('Failed to reset all options:', error);
      this.notificationService.showError(
        this.translate.instant('modals.rcloneConfig.notifications.resetAllError')
      );
    } finally {
      this.isResetting.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  close(): void {
    this.dialogRef.close();
  }
}
