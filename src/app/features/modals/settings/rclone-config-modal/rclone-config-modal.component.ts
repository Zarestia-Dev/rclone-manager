import {
  Component,
  HostListener,
  OnInit,
  inject,
  signal,
  computed,
  effect,
  ChangeDetectionStrategy,
  viewChild,
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ReactiveFormsModule, FormGroup, FormBuilder, FormControl } from '@angular/forms';
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { MatExpansionModule } from '@angular/material/expansion';
import { Subject, debounceTime, distinctUntilChanged, firstValueFrom } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import {
  FlagConfigService,
  RcloneBackendOptionsService,
  NotificationService,
  ModalService,
} from '@app/services';
import { RcConfigOption } from '@app/types';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { SettingControlComponent, JsonEditorComponent } from 'src/app/shared/components';
import { ConfirmModalComponent } from 'src/app/shared/modals/confirm-modal/confirm-modal.component';
import { TitleCasePipe } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';

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
    icon: 'ftp',
    description: 'modals.rcloneConfig.services.ftp',
    mainCategory: 'Network & Servers',
  },
  nfs: {
    icon: 'database',
    description: 'modals.rcloneConfig.services.nfs',
    mainCategory: 'Network & Servers',
  },
  proxy: {
    icon: 'security',
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
    TranslateModule,
  ],
  templateUrl: './rclone-config-modal.component.html',
  styleUrls: ['./rclone-config-modal.component.scss', '../../../../styles/_shared-modal.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RcloneConfigModalComponent implements OnInit {
  private readonly dialogRef = inject(MatDialogRef<RcloneConfigModalComponent>);
  private readonly notificationService = inject(NotificationService);
  private readonly flagConfigService = inject(FlagConfigService);
  private readonly rcloneBackendOptionsService = inject(RcloneBackendOptionsService);
  private readonly dialog = inject(MatDialog);
  private readonly fb = inject(FormBuilder);
  private readonly translate = inject(TranslateService);
  private readonly modalService = inject(ModalService);

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

  // ── Form ───────────────────────────────────────────────────────────────────
  rcloneOptionsForm: FormGroup = this.fb.group({});
  private optionToServiceMap: Record<string, string> = {};
  private optionToFullFieldNameMap: Record<string, string> = {};
  private optionToFocus: string | null = null;
  private readonly search$ = new Subject<string>();

  readonly hasSearchQuery = computed(() => this.searchQuery().trim().length > 0);

  readonly pageTitle = computed(() => {
    if (this.currentPage() === 'home') return 'modals.rcloneConfig.pageTitle.home';
    if (this.currentCategory()) return 'modals.rcloneConfig.pageTitle.category';
    return 'modals.rcloneConfig.pageTitle.backend';
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

  readonly globalSearchResults = computed<SearchResult[]>(() => {
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) return [];

    const results: SearchResult[] = [];
    const options = this.groupedOptions();

    for (const service in options) {
      for (const category in options[service]) {
        for (const option of options[service][category]) {
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
    return results;
  });

  readonly filteredServices = computed<RCloneService[]>(() => {
    const query = this.searchQuery().trim().toLowerCase();

    if (!query) {
      return this.services();
    }

    const matchedServices = new Set(this.globalSearchResults().map(r => r.service));
    return this.services()
      .filter(s => matchedServices.has(s.name) || s.name.toLowerCase().includes(query))
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

    return options.filter(
      opt =>
        opt.Name.toLowerCase().includes(query) ||
        opt.FieldName.toLowerCase().includes(query) ||
        opt.Help.toLowerCase().includes(query)
    );
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
        this.translate.instant('modals.rcloneConfig.notifications.loadError')
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
          if (seen.has(opt.Name)) return false;
          seen.add(opt.Name);
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
          const key = `${service}---${category}---${option.Name}`;
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

    if (this.optionToFocus) {
      queueMicrotask(() => this.scrollToOption(this.optionToFocus!));
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
      ? 'modals.rcloneConfig.search.placeholderHome'
      : 'modals.rcloneConfig.search.placeholderPage';
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

  async saveRCloneOption(optionName: string, isAtDefault: boolean): Promise<void> {
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
      this.notificationService.showError(
        this.translate.instant('modals.rcloneConfig.notifications.saveError', {
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
      await this.rcloneBackendOptionsService.resetOptions();
      await this.loadAndBuildOptions();
      this.notificationService.showSuccess(
        this.translate.instant('modals.rcloneConfig.notifications.resetAllSuccess')
      );
    } catch {
      this.notificationService.showError(
        this.translate.instant('modals.rcloneConfig.notifications.resetAllError')
      );
    } finally {
      this.isResetting.set(false);
    }
  }

  // ── Config accessors ───────────────────────────────────────────────────────

  getUniqueControlKey(option: RcConfigOption): string {
    return `${this.currentPage()}---${this.currentCategory()}---${option.Name}`;
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

  trackBySearchResult(_index: number, result: SearchResult): string {
    return `${result.service}-${result.category}-${result.option.Name}`;
  }

  // ── Modal ──────────────────────────────────────────────────────────────────

  @HostListener('document:keydown.escape')
  close(): void {
    this.modalService.animatedClose(this.dialogRef);
  }
}
