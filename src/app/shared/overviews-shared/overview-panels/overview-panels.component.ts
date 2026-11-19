import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  contentChildren,
  Directive,
  inject,
  input,
  linkedSignal,
  OnInit,
  output,
  TemplateRef,
} from '@angular/core';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';

import {
  applyPanelLayout,
  DashboardPanel,
  defaultPanels,
  OverviewLayout,
  PanelId,
  panelLayoutOf,
  SavedPanelLayout,
} from '@app/types';
import { AppSettingsService } from 'src/app/services/settings/app-settings.service';
import { LocalStorageService } from 'src/app/services/ui/state/local-storage.service';
import { UiStateService } from 'src/app/services/ui/state/ui-state.service';

/** What an overview passes to the content of one of its panels. */
export interface OverviewPanelContext {
  /** Whether the panel is expanded. */
  $implicit: boolean;
  setOpen: (open: boolean) => void;
}

/** Marks the `ng-template` that holds the content of one panel of an `app-overview-panels`. */
@Directive({ selector: 'ng-template[appOverviewPanel]' })
export class OverviewPanelDirective {
  readonly id = input.required<PanelId>({ alias: 'appOverviewPanel' });
  readonly template = inject<TemplateRef<OverviewPanelContext>>(TemplateRef);

  static ngTemplateContextGuard(
    _directive: OverviewPanelDirective,
    _context: unknown
  ): _context is OverviewPanelContext {
    return true;
  }
}

/**
 * The panels of an overview: their order and visibility, which of them are expanded, and the layout
 * editor that drags and hides them. The overview supplies the content of each panel.
 */
@Component({
  selector: 'app-overview-panels',
  imports: [
    NgTemplateOutlet,
    DragDropModule,
    MatButtonModule,
    MatExpansionModule,
    MatIconModule,
    MatSlideToggleModule,
    TranslatePipe,
  ],
  templateUrl: './overview-panels.component.html',
  styleUrl: './overview-panels.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OverviewPanelsComponent implements OnInit {
  readonly layout = input.required<OverviewLayout>();

  /** The layout went back to its defaults; the overview resets what else it keeps with it. */
  readonly layoutReset = output<void>();
  /** The reset button of a `resettable` panel was pressed. */
  readonly panelReset = output<PanelId>();

  private readonly appSettingsService = inject(AppSettingsService);
  private readonly localStorage = inject(LocalStorageService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly uiStateService = inject(UiStateService);

  private readonly templates = contentChildren(OverviewPanelDirective);

  protected readonly isEditing = computed(() =>
    this.uiStateService.isEditingOverview(this.layout().id)
  );

  protected readonly panels = linkedSignal<DashboardPanel[]>(() =>
    defaultPanels(this.layout().panels)
  );
  protected readonly displayPanels = computed(() =>
    this.isEditing() ? this.panels() : this.panels().filter(panel => panel.visible)
  );

  private readonly openStates = linkedSignal<Record<string, boolean>>(() =>
    this.localStorage.get(this.layout().openStatesKey, { ...this.layout().openByDefault })
  );

  protected readonly contexts = computed(
    () =>
      Object.fromEntries(
        this.layout().panels.map(panel => [
          panel.id,
          {
            $implicit: this.openStates()[panel.id] ?? false,
            setOpen: (open: boolean): void => this.setOpen(panel.id, open),
          },
        ])
      ) as Record<PanelId, OverviewPanelContext>
  );

  ngOnInit(): void {
    void this.loadLayout();
  }

  /** Starts or ends the editing of this overview's layout. */
  toggleEditLayout(): void {
    const { id, hasViewToggle } = this.layout();
    this.uiStateService.toggleLayoutEdit({
      overviewId: id,
      hasViewToggle,
      onReset: () => this.resetLayout(),
    });
  }

  protected templateOf(id: PanelId): TemplateRef<OverviewPanelContext> | undefined {
    return this.templates().find(directive => directive.id() === id)?.template;
  }

  protected drop(event: CdkDragDrop<DashboardPanel[]>): void {
    this.panels.update(panels => {
      const updated = [...panels];
      moveItemInArray(updated, event.previousIndex, event.currentIndex);
      return updated;
    });
    this.persistLayout();
  }

  protected togglePanelVisibility(id: PanelId): void {
    this.panels.update(panels =>
      panels.map(panel => (panel.id === id ? { ...panel, visible: !panel.visible } : panel))
    );
    this.persistLayout();
  }

  private setOpen(id: PanelId, open: boolean): void {
    const updated = { ...this.openStates(), [id]: open };
    this.openStates.set(updated);
    this.localStorage.set(this.layout().openStatesKey, updated);
  }

  private resetLayout(): void {
    void this.appSettingsService.saveSetting('runtime', this.layout().setting, {
      order: [],
      hidden: [],
    });
    this.panels.set(defaultPanels(this.layout().panels));
    this.snackBar.open(
      this.translate.instant('generalOverview.layout.resetSuccess'),
      this.translate.instant('common.close'),
      { duration: 2000 }
    );
    this.layoutReset.emit();
  }

  private persistLayout(): void {
    void this.appSettingsService.saveSetting(
      'runtime',
      this.layout().setting,
      panelLayoutOf(this.panels())
    );
  }

  private async loadLayout(): Promise<void> {
    const { setting, panels } = this.layout();
    try {
      const saved = await this.appSettingsService.getSettingValue<SavedPanelLayout>(
        `runtime.${setting}`
      );
      this.panels.set(applyPanelLayout(panels, saved));
    } catch {
      console.debug(`Failed to load the ${setting} setting, using the default layout`);
    }
  }
}
