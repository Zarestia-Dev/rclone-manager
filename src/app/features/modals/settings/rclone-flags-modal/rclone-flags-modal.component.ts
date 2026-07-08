import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
  effect,
  ChangeDetectionStrategy,
  viewChild,
} from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { EscapeCloseDirective } from '../../../../shared/directives/escape-close.directive';
import { MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ReactiveFormsModule, FormGroup, FormBuilder, FormControl } from '@angular/forms';
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { MatExpansionModule } from '@angular/material/expansion';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { FlagConfigService } from 'src/app/services/remote/flag-config.service';
import { RcloneBackendOptionsService } from 'src/app/services/settings/rclone-backend-options.service';
import { NotificationService } from 'src/app/services/ui/notification.service';
import {
  matchesConfigSearch,
  stripCliPrefix,
} from 'src/app/services/remote/utils/remote-config.utils';
import {
  RcConfigOption,
  SharedProfileType,
  PageType,
  GroupedRCloneOptions,
  RCloneService,
  RCloneFlagsSearchResult,
  ServiceConfig,
} from '@app/types';
import { RcloneOptionTranslatePipe } from '@app/pipes';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { SettingControlComponent } from 'src/app/shared/components/setting-control/setting-control.component';
import {
  JsonEditorComponent,
  JSON_EDITOR_LOOKUP_TABLE,
} from 'src/app/shared/components/json-editor/json-editor.component';
import { TitleCasePipe } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';

const SERVICE_CONFIG: Record<string, ServiceConfig> = {
  vfs: {
    icon: 'vfs',
    description: 'modals.rcloneFlags.services.vfs',
    mainCategory: 'File System & Storage',
  },
  mount: {
    icon: 'mount',
    description: 'modals.rcloneFlags.services.mount',
    mainCategory: 'File System & Storage',
  },
  filter: {
    icon: 'filter',
    description: 'modals.rcloneFlags.services.filter',
    mainCategory: 'File System & Storage',
  },
  main: {
    icon: 'gear',
    description: 'modals.rcloneFlags.services.main',
    mainCategory: 'General Settings',
  },
  log: {
    icon: 'file-lines',
    description: 'modals.rcloneFlags.services.log',
    mainCategory: 'General Settings',
  },
  http: {
    icon: 'globe',
    description: 'modals.rcloneFlags.services.http',
    mainCategory: 'Network & Servers',
  },
  rc: {
    icon: 'server',
    description: 'modals.rcloneFlags.services.rc',
    mainCategory: 'General Settings',
  },
  dlna: {
    icon: 'tv',
    description: 'modals.rcloneFlags.services.dlna',
    mainCategory: 'Network & Servers',
  },
  ftp: {
    icon: 'ftp',
    description: 'modals.rcloneFlags.services.ftp',
    mainCategory: 'Network & Servers',
  },
  nfs: {
    icon: 'database',
    description: 'modals.rcloneFlags.services.nfs',
    mainCategory: 'Network & Servers',
  },
  proxy: {
    icon: 'security',
    description: 'modals.rcloneFlags.services.proxy',
    mainCategory: 'General Settings',
  },
  restic: {
    icon: 'box-archive',
    description: 'modals.rcloneFlags.services.restic',
    mainCategory: 'Network & Servers',
  },
  s3: {
    icon: 'bucket',
    description: 'modals.rcloneFlags.services.s3',
    mainCategory: 'Network & Servers',
  },
  sftp: {
    icon: 'lock',
    description: 'modals.rcloneFlags.services.sftp',
    mainCategory: 'Network & Servers',
  },
  webdav: {
    icon: 'cloud',
    description: 'modals.rcloneFlags.services.webdav',
    mainCategory: 'Network & Servers',
  },
};

const CATEGORY_CONFIG: Record<string, { icon: string; description: string }> = {
  General: { icon: 'gear', description: 'modals.rcloneFlags.categories.General' },
  Auth: { icon: 'lock', description: 'modals.rcloneFlags.categories.Auth' },
  HTTP: { icon: 'globe', description: 'modals.rcloneFlags.categories.HTTP' },
  Template: { icon: 'terminal', description: 'modals.rcloneFlags.categories.Template' },
  MetaRules: { icon: 'chart', description: 'modals.rcloneFlags.categories.MetaRules' },
  RulesOpt: { icon: 'filter', description: 'modals.rcloneFlags.categories.RulesOpt' },
  MetricsAuth: { icon: 'lock', description: 'modals.rcloneFlags.categories.MetricsAuth' },
  MetricsHTTP: { icon: 'globe', description: 'modals.rcloneFlags.categories.MetricsHTTP' },
};

const MAIN_CATEGORY_CONFIG: Record<
  string,
  { icon: string; description: string; titleKey: string }
> = {
  'General Settings': {
    icon: 'gear',
    description: 'modals.rcloneFlags.mainCategories.generalSettings.description',
    titleKey: 'modals.rcloneFlags.mainCategories.generalSettings.title',
  },
  'File System & Storage': {
    icon: 'folder',
    description: 'modals.rcloneFlags.mainCategories.fileSystemAndStorage.description',
    titleKey: 'modals.rcloneFlags.mainCategories.fileSystemAndStorage.title',
  },
  'Network & Servers': {
    icon: 'public',
    description: 'modals.rcloneFlags.mainCategories.networkAndServers.description',
    titleKey: 'modals.rcloneFlags.mainCategories.networkAndServers.title',
  },
};

interface OptionViewModel {
  option: RcConfigOption;
  uniqueKey: string;
}

interface CategoryViewModel {
  category: string;
  icon: string;
  description: string;
  matchCount: number;
}

interface ServiceViewModel {
  name: string;
  expanded: boolean;
  icon: string;
  description: string;
  categories: CategoryViewModel[];
}

interface MainCategoryViewModel {
  name: string;
  titleKey: string;
  description: string;
  services: ServiceViewModel[];
}

interface SearchResultViewModel {
  result: RCloneFlagsSearchResult;
  serviceIcon: string;
}

@Component({
  selector: 'app-rclone-flags-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    TitleCasePipe,
    MatIconModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    MatExpansionModule,
    ScrollingModule,
    ReactiveFormsModule,
    SearchContainerComponent,
    SettingControlComponent,
    JsonEditorComponent,
    MatTooltipModule,
    TranslatePipe,
    RcloneOptionTranslatePipe,
  ],
  templateUrl: './rclone-flags-modal.component.html',
  styleUrls: ['./rclone-flags-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: JSON_EDITOR_LOOKUP_TABLE,
      useFactory: (modal: RcloneFlagsModalComponent): any => modal.lookupTable,
      deps: [RcloneFlagsModalComponent],
    },
  ],
})
export class RcloneFlagsModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<RcloneFlagsModalComponent>);
  private readonly notificationService = inject(NotificationService);
  private readonly flagConfigService = inject(FlagConfigService);
  private readonly rcloneBackendOptionsService = inject(RcloneBackendOptionsService);
  private readonly fb = inject(FormBuilder);
  readonly translate = inject(TranslateService);

  readonly virtualScrollViewport = viewChild(CdkVirtualScrollViewport);

  // ── Primary state ──────────────────────────────────────────────────────────
  readonly currentPage = signal<PageType>('home');
  readonly currentCategory = signal<string | null>(null);
  readonly isLoading = signal(true);
  readonly searchQuery = signal('');
  readonly isSearchVisible = signal(false);
  readonly showJsonMode = signal(false);
  readonly savingOptions = signal(new Set<string>());
  readonly isResetting = signal(false);

  private readonly groupedOptions = signal<GroupedRCloneOptions>({});
  private readonly changedOptions = signal(new Set<string>());

  private readonly expandedServices = signal(new Set<string>());

  readonly lookupTable = computed(() => {
    const table: Record<string, { option: RcConfigOption; flagType: SharedProfileType }> = {};
    const options = this.groupedOptions();
    for (const service in options) {
      for (const category in options[service]) {
        for (const option of options[service][category]) {
          const nameRaw = (option.Name ?? '').toLowerCase();
          const nameHyphen = nameRaw.replace(/_/g, '-');
          const keyCamel = (option.FieldName ?? '').toLowerCase();
          const flagType = service as SharedProfileType;

          if (nameRaw) {
            table[nameRaw] = { option, flagType };
          }
          if (nameHyphen && nameHyphen !== nameRaw) {
            table[nameHyphen] = { option, flagType };
          }
          if (keyCamel && keyCamel !== nameRaw && keyCamel !== nameHyphen) {
            table[keyCamel] = { option, flagType };
          }
        }
      }
    }
    return table;
  });

  // ── Form ───────────────────────────────────────────────────────────────────
  rcloneOptionsForm: FormGroup = this.fb.group({});
  private optionToServiceMap: Record<string, string> = {};
  private optionToFullFieldNameMap: Record<string, string> = {};
  private optionToFocus: string | null = null;
  private readonly search$ = new Subject<string>();

  readonly hasSearchQuery = computed(() => this.searchQuery().trim().length > 0);

  readonly pageTitle = computed(() => {
    if (this.currentPage() === 'home') return 'modals.rcloneFlags.pageTitle.home';
    if (this.currentCategory()) return 'modals.rcloneFlags.pageTitle.category';
    return 'modals.rcloneFlags.pageTitle.backend';
  });

  readonly pageTitleParams = computed(() => {
    const category = this.currentCategory();
    if (!category) return {};
    return { page: this.currentPage().toUpperCase(), category };
  });

  readonly services = computed<RCloneService[]>(() =>
    Object.entries(this.groupedOptions()).map(([name, cats]) => ({
      name,
      expanded: this.expandedServices().has(name),
      categories: Object.keys(cats),
    }))
  );

  readonly globalSearchResults = computed<RCloneFlagsSearchResult[]>(() => {
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) return [];

    const cleanQuery = stripCliPrefix(query);

    const results: RCloneFlagsSearchResult[] = [];
    const options = this.groupedOptions();

    for (const service in options) {
      for (const category in options[service]) {
        for (const option of options[service][category]) {
          if (
            matchesConfigSearch(option, query) ||
            service.toLowerCase().includes(cleanQuery) ||
            category.toLowerCase().includes(cleanQuery)
          ) {
            results.push({ service, category, option });
          }
        }
      }
    }
    return results;
  });

  readonly filteredServices = computed<RCloneService[]>(() => {
    const query = this.searchQuery().trim().toLowerCase();

    if (!query) {
      return this.services();
    }

    const cleanQuery = stripCliPrefix(query);

    const matchedServices = new Set(this.globalSearchResults().map(r => r.service));
    return this.services()
      .filter(s => matchedServices.has(s.name) || s.name.toLowerCase().includes(cleanQuery))
      .map(s => ({ ...s, expanded: true }));
  });

  readonly searchMatchCounts = computed<Map<string, number>>(() => {
    const counts = new Map<string, number>();
    for (const r of this.globalSearchResults()) {
      const key = `${r.service}---${r.category}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  });

  readonly virtualScrollData = computed<RcConfigOption[]>(() => {
    const page = this.currentPage();
    const category = this.currentCategory();
    if (page === 'home' || !category) return [];

    const options = this.groupedOptions()[page]?.[category] ?? [];
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) return options;

    return options.filter(opt => matchesConfigSearch(opt, query));
  });

  readonly filteredOptionsCount = computed(() => this.virtualScrollData().length);

  readonly totalOptionsCount = computed(() => {
    const page = this.currentPage();
    const category = this.currentCategory();
    if (page === 'home' || !category) return 0;
    return (this.groupedOptions()[page]?.[category] ?? []).length;
  });

  readonly servicesByMainCategory = computed(() => {
    const grouped: Record<string, RCloneService[]> = {
      'General Settings': [],
      'File System & Storage': [],
      'Network & Servers': [],
    };
    for (const service of this.filteredServices()) {
      const mainCat = SERVICE_CONFIG[service.name]?.mainCategory ?? 'Network & Servers';
      grouped[mainCat]?.push(service);
    }
    return grouped;
  });

  readonly editorKeyPrefix = computed(() => `${this.currentPage()}---${this.currentCategory()}---`);

  readonly categoryOptions = computed<RcConfigOption[]>(() => {
    const page = this.currentPage();
    const category = this.currentCategory();
    if (page === 'home' || !category) return [];
    return this.groupedOptions()[page]?.[category] ?? [];
  });

  readonly mainCategoryViewModels = computed<MainCategoryViewModel[]>(() => {
    const order = ['General Settings', 'File System & Storage', 'Network & Servers'];
    const grouped = this.servicesByMainCategory();
    return order
      .map((name): MainCategoryViewModel => {
        const cfg = MAIN_CATEGORY_CONFIG[name];
        const services = (grouped[name] ?? []).map((svc): ServiceViewModel => {
          const serviceCfg = SERVICE_CONFIG[svc.name];
          const categories = svc.categories.map((catName): CategoryViewModel => {
            const catCfg = CATEGORY_CONFIG[catName];
            return {
              category: catName,
              icon: catCfg?.icon ?? 'gear',
              description: catCfg?.description ?? '',
              matchCount: this.getMatchCountForCategory(svc.name, catName),
            };
          });
          return {
            name: svc.name,
            expanded: svc.expanded,
            icon: serviceCfg?.icon ?? 'gear',
            description: serviceCfg?.description ?? '',
            categories,
          };
        });
        return {
          name,
          titleKey: cfg?.titleKey ?? name,
          description: cfg?.description ?? '',
          services,
        };
      })
      .filter(mc => mc.services.length > 0);
  });

  readonly globalSearchResultViewModels = computed<SearchResultViewModel[]>(() =>
    this.globalSearchResults().map(r => ({
      result: r,
      serviceIcon: this.getServiceIcon(r.service),
    }))
  );

  readonly virtualScrollOptionViewModels = computed<OptionViewModel[]>(() =>
    this.virtualScrollData().map(opt => {
      const uniqueKey = this.getUniqueControlKey(opt);
      return {
        option: opt,
        uniqueKey,
      };
    })
  );

  // ── Constructor ────────────────────────────────────────────────────────────

  constructor() {
    this.setupSearchSubscription();
    this.setupVirtualScrollEffect();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async ngOnInit(): Promise<void> {
    await this.loadAndBuildOptions();
    this.isLoading.set(false);
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  private setupSearchSubscription(): void {
    this.search$
      .pipe(debounceTime(200), distinctUntilChanged(), takeUntilDestroyed())
      .subscribe(text => this.searchQuery.set(text.toLowerCase().trim()));
  }

  private setupVirtualScrollEffect(): void {
    effect(() => {
      if (this.virtualScrollData().length > 0) {
        queueMicrotask(() => this.virtualScrollViewport()?.scrollToIndex(0));
      }
    });
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  private async loadAndBuildOptions(): Promise<void> {
    try {
      const options = await this.flagConfigService.getGroupedOptions();
      const deduplicated = this.deduplicateOptions(options);
      this.groupedOptions.set(deduplicated);
      this.createFormControls(deduplicated);
    } catch {
      this.notificationService.showError(
        this.translate.instant('modals.rcloneFlags.notifications.loadError')
      );
    }
  }

  /** Remove duplicate options (same Name) within each service+category. */
  private deduplicateOptions(options: GroupedRCloneOptions): GroupedRCloneOptions {
    const result: GroupedRCloneOptions = {};
    for (const service in options) {
      result[service] = {};
      for (const category in options[service]) {
        const seen = new Set<string>();
        result[service][category] = options[service][category].filter(opt => {
          const key = opt.FieldName || opt.Name;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
    }
    return result;
  }

  private createFormControls(options: GroupedRCloneOptions): void {
    const controls: Record<string, FormControl> = {};
    // Reset lookup maps on each (re-)load
    this.optionToServiceMap = {};
    this.optionToFullFieldNameMap = {};

    for (const service in options) {
      for (const category in options[service]) {
        for (const option of options[service][category]) {
          const fullFieldName =
            category === 'General' ? option.FieldName : `${category}.${option.FieldName}`;
          const key = `${service}---${category}---${option.FieldName || option.Name}`;
          this.optionToServiceMap[key] = service;
          this.optionToFullFieldNameMap[key] = fullFieldName;
          controls[key] = this.fb.control(option.Value);
        }
      }
    }

    this.rcloneOptionsForm = this.fb.group(controls);
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  navigateTo(service: string, category?: string, optionName?: string): void {
    this.currentPage.set(service);
    this.currentCategory.set(category ?? null);
    this.optionToFocus = optionName ?? null;

    const focus = this.optionToFocus;
    if (focus) {
      queueMicrotask(() => this.scrollToOption(focus));
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
    const viewport = this.virtualScrollViewport();
    if (viewport) {
      const index = this.virtualScrollData().findIndex(opt => opt.Name === optionName);
      if (index !== -1) viewport.scrollToIndex(index, 'smooth');
    }
    this.optionToFocus = null;
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  onSearchInput(searchText: string): void {
    this.search$.next(searchText);
  }

  getSearchPlaceholder(): string {
    return this.currentPage() === 'home'
      ? 'modals.rcloneFlags.search.placeholderHome'
      : 'modals.rcloneFlags.search.placeholderPage';
  }

  getMatchCountForCategory(serviceName: string, categoryName: string): number {
    return this.searchMatchCounts().get(`${serviceName}---${categoryName}`) ?? 0;
  }

  toggleSearchVisibility(): void {
    this.isSearchVisible.update(v => !v);
    if (!this.isSearchVisible()) {
      this.search$.next('');
    }
  }

  toggleJsonMode(): void {
    this.showJsonMode.update(v => !v);
  }

  // ── Service panel state ────────────────────────────────────────────────────
  setServiceExpanded(name: string, isExpanded: boolean): void {
    this.expandedServices.update(s => {
      const next = new Set(s);
      if (isExpanded) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });
  }

  // ── Option state ───────────────────────────────────────────────────────────

  onOptionValueChanged(optionName: string, isChanged: boolean): void {
    this.changedOptions.update(s => {
      const next = new Set(s);
      if (isChanged) {
        next.add(optionName);
      } else {
        next.delete(optionName);
      }
      return next;
    });
  }

  isOptionAtDefault(optionName: string): boolean {
    return !this.changedOptions().has(optionName);
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  async saveRCloneOption(optionName: string): Promise<void> {
    const isAtDefault = this.isOptionAtDefault(optionName);
    const control = this.rcloneOptionsForm.get(optionName);
    if (!control || control.invalid || this.savingOptions().has(optionName) || control.pristine) {
      return;
    }

    this.savingOptions.update(s => new Set([...s, optionName]));
    control.disable({ emitEvent: false });

    try {
      const service = this.optionToServiceMap[optionName];
      const fullFieldName = this.optionToFullFieldNameMap[optionName];

      if (!service || !fullFieldName) {
        throw new Error(`Mapping not found for ${optionName}`);
      }

      let valueToSave = control.value;
      if (Array.isArray(valueToSave)) {
        valueToSave = valueToSave.filter(Boolean);
      }

      if (isAtDefault) {
        await this.rcloneBackendOptionsService.removeOption(service, fullFieldName);
        this.notificationService.showSuccess(
          this.translate.instant('modals.rcloneFlags.notifications.resetSuccess', {
            field: fullFieldName,
          })
        );
      } else {
        await this.rcloneBackendOptionsService.saveOption(service, fullFieldName, valueToSave);
        this.notificationService.showSuccess(
          this.translate.instant('modals.rcloneFlags.notifications.saveSuccess', {
            field: fullFieldName,
          })
        );
      }

      await this.flagConfigService.saveOption(service, fullFieldName, valueToSave);
      control.markAsPristine();
    } catch (error) {
      this.notificationService.showError(
        this.translate.instant('modals.rcloneFlags.notifications.saveError', {
          field: optionName,
          error: error as string,
        })
      );
    } finally {
      this.savingOptions.update(s => {
        const n = new Set(s);
        n.delete(optionName);
        return n;
      });
      control?.enable({ emitEvent: false });
    }
  }

  async resetAllOptions(): Promise<void> {
    const confirmed = await this.notificationService.confirmModal(
      'modals.rcloneFlags.reset.title',
      'modals.rcloneFlags.reset.message',
      'modals.rcloneFlags.reset.confirm',
      'common.cancel',
      { color: 'warn', icon: 'circle-exclamation' }
    );
    if (!confirmed) return;

    this.isResetting.set(true);
    try {
      await this.rcloneBackendOptionsService.resetOptions();
      await this.loadAndBuildOptions();
      this.notificationService.showSuccess(
        this.translate.instant('modals.rcloneFlags.notifications.resetAllSuccess')
      );
    } catch {
      this.notificationService.showError(
        this.translate.instant('modals.rcloneFlags.notifications.resetAllError')
      );
    } finally {
      this.isResetting.set(false);
    }
  }

  // ── Config accessors ───────────────────────────────────────────────────────

  getUniqueControlKey(option: RcConfigOption): string {
    return `${this.currentPage()}---${this.currentCategory()}---${option.FieldName || option.Name}`;
  }

  getServiceIcon(name: string): string {
    return SERVICE_CONFIG[name]?.icon ?? 'gear';
  }

  getServiceDescription(name: string): string {
    return SERVICE_CONFIG[name]?.description ?? '';
  }

  getCategoryIcon(name: string): string {
    return CATEGORY_CONFIG[name]?.icon ?? 'gear';
  }

  getCategoryDescription(name: string): string {
    return CATEGORY_CONFIG[name]?.description ?? '';
  }

  getMainCategoryTitle(name: string): string {
    return MAIN_CATEGORY_CONFIG[name]?.titleKey ?? name;
  }

  getMainCategoryDescription(name: string): string {
    return MAIN_CATEGORY_CONFIG[name]?.description ?? '';
  }

  // ── Track functions ────────────────────────────────────────────────────────

  trackByOption(_index: number, option: RcConfigOption): string {
    return option.Name;
  }

  trackBySearchResult(_index: number, result: RCloneFlagsSearchResult): string {
    return `${result.service}-${result.category}-${result.option.Name}`;
  }

  // ── Modal ──────────────────────────────────────────────────────────────────

  close(): void {
    this.dialogRef.close();
  }
}
