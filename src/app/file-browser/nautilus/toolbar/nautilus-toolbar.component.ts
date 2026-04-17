import {
  Component,
  inject,
  viewChild,
  ElementRef,
  input,
  output,
  effect,
  computed,
  TemplateRef,
  Injector,
  signal,
  afterNextRender,
  afterRenderEffect,
} from '@angular/core';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { CdkMenuModule } from '@angular/cdk/menu';
import { IconService, NautilusService } from '@app/services';
import { WindowControlsComponent } from '@app/shared/components';
import { ExplorerRoot } from '@app/types';
import { ScrollShadowDirective } from '../../../shared/directives/scroll-shadow.directive';

@Component({
  selector: 'app-nautilus-toolbar',
  standalone: true,
  imports: [
    MatToolbarModule,
    MatIconModule,
    TranslateModule,
    CdkMenuModule,
    WindowControlsComponent,
    ScrollShadowDirective,
  ],
  templateUrl: './nautilus-toolbar.component.html',
  styleUrl: './nautilus-toolbar.component.scss',
})
export class NautilusToolbarComponent {
  protected readonly iconService = inject(IconService);
  protected readonly nautilusService = inject(NautilusService);
  private readonly injector = inject(Injector);

  // --- Inputs ---
  public readonly isMobile = input.required<boolean>();
  public readonly canGoBack = input.required<boolean>();
  public readonly canGoForward = input.required<boolean>();
  public readonly isSearchMode = input.required<boolean>();
  public readonly searchFilter = input.required<string>();
  public readonly isEditingPath = input.required<boolean>();
  public readonly starredMode = input.required<boolean>();
  public readonly activeRemote = input.required<ExplorerRoot | null>();
  public readonly pathSegments = input.required<{ name: string; path: string }[]>();
  public readonly isDragging = input.required<boolean>();
  public readonly hoveredSegmentIndex = input.required<number | null>();
  public readonly fullPathInput = input.required<string>();
  public readonly layout = input.required<'grid' | 'list'>();
  public readonly pathOptionsMenu = input.required<TemplateRef<unknown>>();
  public readonly viewMenu = input.required<TemplateRef<unknown>>();

  // --- Outputs ---
  public readonly goBack = output<void>();
  public readonly goForward = output<void>();
  public readonly navigateToSegment = output<number>();
  public readonly updatePath = output<string>();
  public readonly navigateToPath = output<string>();
  public readonly layoutChange = output<'grid' | 'list'>();
  public readonly closeOverlay = output<void>();
  public readonly copyUrl = output<void>();
  public readonly searchFilterChange = output<string>();
  public readonly isSearchModeChange = output<boolean>();
  public readonly isEditingPathChange = output<boolean>();
  public readonly droppedOnSegment = output<{ event: DragEvent; segmentIndex: number }>();

  // --- View Children ---
  protected readonly pathScrollView = viewChild<ElementRef<HTMLDivElement>>('pathScrollView');
  protected readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  protected readonly pathInput = viewChild<ElementRef<HTMLInputElement>>('pathInput');

  // --- State ---
  protected readonly showLeft = signal(false);
  protected readonly showRight = signal(false);

  protected readonly toggledLayout = computed((): 'grid' | 'list' =>
    this.layout() === 'grid' ? 'list' : 'grid'
  );

  constructor() {
    afterRenderEffect(() => {
      this.pathSegments(); // tracked dependency
      this.pathScrollView()?.nativeElement.scrollTo({ left: 999999, behavior: 'smooth' });
    });

    effect(() => {
      if (this.isEditingPath()) {
        afterNextRender(() => this.pathInput()?.nativeElement.select(), {
          injector: this.injector,
        });
      } else if (this.isSearchMode()) {
        afterNextRender(
          () => {
            const el = this.searchInput()?.nativeElement;
            el?.focus();
            el?.select();
          },
          { injector: this.injector }
        );
      }
    });
  }

  protected onSearchEscape(inputElement: HTMLInputElement, event: Event): void {
    event.stopPropagation();
    this.searchFilterChange.emit('');
    this.isSearchModeChange.emit(false);
    inputElement.blur();
  }

  protected onSearchBlur(): void {
    if (!this.searchFilter().trim()) {
      this.isSearchModeChange.emit(false);
    }
  }

  protected onPathContainerClick(): void {
    if (!this.isSearchMode() && !this.isEditingPath()) {
      this.isEditingPathChange.emit(true);
    }
  }

  protected onPathContainerEscape(event: Event): void {
    if (event.target !== event.currentTarget) return;
    this.isEditingPathChange.emit(false);
    this.isSearchModeChange.emit(false);
  }
}
