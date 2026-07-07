import {
  Component,
  inject,
  computed,
  viewChild,
  TemplateRef,
  input,
  output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { CdkMenuModule } from '@angular/cdk/menu';

import { NautilusTabService } from 'src/app/services/ui/nautilus-tab.service';
import { NautilusActionsService } from 'src/app/services/ui/nautilus-actions.service';
import { NautilusFileOperationsService } from 'src/app/services/ui/nautilus-file-operations.service';
import { NautilusSettingsService } from 'src/app/services/ui/nautilus-settings.service';
import { NautilusSelectionService } from 'src/app/services/ui/nautilus-selection.service';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { RemoteFacadeService } from 'src/app/services/facade/remote-facade.service';
import { CopyToClipboardDirective } from '../../../shared/directives/copy-to-clipboard.directive';
import { SlideMenuController } from '../slide-menu';
import { FileBrowserItem, FilePickerConfig, DEFAULT_PICKER_OPTIONS } from '@app/types';

@Component({
  selector: 'app-nautilus-context-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslatePipe,
    MatIconModule,
    MatDividerModule,
    CdkMenuModule,
    CopyToClipboardDirective,
  ],
  templateUrl: './nautilus-context-menu.component.html',
  styleUrls: ['../../../styles/_slide-menu.scss'],
})
export class NautilusContextMenuComponent {
  // Services
  public readonly tabSvc = inject(NautilusTabService);
  public readonly actions = inject(NautilusActionsService);
  public readonly fileOps = inject(NautilusFileOperationsService);
  public readonly settings = inject(NautilusSettingsService);
  protected readonly selectionSvc = inject(NautilusSelectionService);
  protected readonly pathService = inject(PathService);
  private readonly remoteFacadeSvc = inject(RemoteFacadeService);

  // Inputs
  readonly files = input<FileBrowserItem[]>([]);
  readonly filesRight = input<FileBrowserItem[]>([]);
  readonly isPickerMode = input<boolean>(false);
  readonly pickerOptions = input<FilePickerConfig>(DEFAULT_PICKER_OPTIONS);
  readonly isCurrentPathRegistered = input<boolean>(false);

  // Outputs
  readonly navigateTo = output<FileBrowserItem>();
  readonly uploadFiles = output<void>();
  readonly uploadFolder = output<void>();
  readonly pasteItems = output<void>();
  readonly selectAll = output<void>();
  readonly toggleSendTo = output<void>();

  // Template references for parent integration
  readonly fileMenuTemplate = viewChild<TemplateRef<unknown>>('fileMenuTemplate');
  readonly pathOptionsMenuTemplate = viewChild<TemplateRef<unknown>>('pathOptionsMenuTemplate');

  // Slide animation controller
  readonly menuCtrl = new SlideMenuController('.nautilus-sliding-container');

  // Computeds
  protected readonly activeSelectionCount = computed(() => {
    return this.tabSvc.activePaneIndex() === 0
      ? this.tabSvc.selectedItems().size
      : this.tabSvc.selectedItemsRight().size;
  });

  protected readonly supportsPublicLink = computed(() => {
    const item = this.actions.contextMenuItem();
    const remote = this.tabSvc.activeRemote();
    const activeRemoteName = item?.meta.remote ?? remote?.name;
    if (!activeRemoteName) return false;
    const isLocal = item?.meta.isLocal ?? remote?.isLocal ?? true;
    if (isLocal) return false;
    const baseName = this.pathService.normalizeRemoteName(activeRemoteName);
    const features = this.remoteFacadeSvc.featuresSignal(baseName)();
    return !!features?.PublicLink;
  });

  protected readonly fullPathInput = computed(() => {
    if (this.tabSvc.activeStarredMode()) return '';
    return this.pathService.getFullDisplayPath(
      this.tabSvc.activeRemote(),
      this.tabSvc.activePath()
    );
  });

  reset(): void {
    this.menuCtrl.reset();
  }

  protected copyItems(): void {
    const filesList = this.tabSvc.activePaneIndex() === 0 ? this.files() : this.filesRight();
    this.fileOps.copyItems(this.selectionSvc.getSelectedItemsList(filesList));
  }

  protected cutItems(): void {
    const filesList = this.tabSvc.activePaneIndex() === 0 ? this.files() : this.filesRight();
    this.fileOps.cutItems(this.selectionSvc.getSelectedItemsList(filesList));
  }

  protected openContextMenuOpen(): void {
    const item = this.actions.contextMenuItem();
    if (item) {
      this.navigateTo.emit(item);
    }
  }

  protected getFormattedPath(item: FileBrowserItem | null): string {
    if (!item) return this.fullPathInput();
    return this.pathService.getFullDisplayPath(this.tabSvc.activeRemote(), item.entry.Path);
  }
}
