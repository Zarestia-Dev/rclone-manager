import {
  Component,
  inject,
  viewChild,
  ElementRef,
  input,
  output,
  effect,
  signal,
  TemplateRef,
} from '@angular/core';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { CdkMenuModule } from '@angular/cdk/menu';

import { IconService } from '@app/services';
import { ExplorerRoot } from '@app/types';

@Component({
  selector: 'app-nautilus-toolbar',
  standalone: true,
  imports: [MatToolbarModule, MatIconModule, TranslateModule, CdkMenuModule],
  templateUrl: './nautilus-toolbar.component.html',
  styleUrl: './nautilus-toolbar.component.scss',
})
export class NautilusToolbarComponent {
  protected readonly iconService = inject(IconService);

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
  public readonly searchFilterChange = output<string>();
  public readonly isSearchModeChange = output<boolean>();
  public readonly isEditingPathChange = output<boolean>();
  public readonly droppedOnSegment = output<{ event: DragEvent; segmentIndex: number }>();

  // --- View Children ---
  protected readonly pathScrollView = viewChild<ElementRef<HTMLDivElement>>('pathScrollView');
  protected readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  protected readonly pathInput = viewChild<ElementRef<HTMLInputElement>>('pathInput');

  // --- Scroll Shadow State ---
  protected readonly _showLeftShadow = signal(false);
  protected readonly _showRightShadow = signal(false);

  constructor() {
    // Scroll breadcrumb to the end whenever the path changes
    effect(() => {
      this.pathSegments();
      this.scrollToEnd();
    });

    // Auto-focus and select the relevant input when entering edit or search mode.
    // setTimeout(0) defers until after Angular has rendered the @if branch that
    // conditionally renders the input element.
    effect(() => {
      if (this.isEditingPath()) {
        setTimeout(() => this.pathInput()?.nativeElement.select(), 0);
      } else if (this.isSearchMode()) {
        setTimeout(() => {
          this.searchInput()?.nativeElement.focus();
          this.searchInput()?.nativeElement.select();
        }, 0);
      }
    });
  }

  private scrollToEnd(): void {
    const el = this.pathScrollView()?.nativeElement;
    if (!el) return;
    // Defer one tick so the DOM reflects the new segments before we measure scrollWidth.
    setTimeout(() => {
      el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
      this.updateScrollShadows();
    }, 0);
  }

  /** Called by the template's (scroll) binding on the path scroll view. */
  protected onScrollViewScroll(): void {
    this.updateScrollShadows();
  }

  private updateScrollShadows(): void {
    const el = this.pathScrollView()?.nativeElement;
    if (!el) return;
    // 4 px threshold prevents shadow flicker at near-zero scroll positions.
    this._showLeftShadow.set(el.scrollLeft > 4);
    this._showRightShadow.set(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  }

  protected onPathScroll(event: WheelEvent): void {
    const el = this.pathScrollView()?.nativeElement;
    if (!el) return;
    el.scrollLeft += event.deltaY;
    event.preventDefault();
  }

  protected onSearchEscape(inputElement: HTMLInputElement, event: Event): void {
    // Stop propagation so the path-container keydown.escape handler doesn't double-fire.
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
    // Guard: only enter edit mode when idle — not already editing or searching.
    if (!this.isSearchMode() && !this.isEditingPath()) {
      this.isEditingPathChange.emit(true);
    }
  }

  protected onPathContainerEscape(event: Event): void {
    // Only handle escape when the container itself is the event target,
    // not when it bubbles up from a child input (those stop propagation themselves).
    if (event.target !== event.currentTarget) return;
    this.isEditingPathChange.emit(false);
    this.isSearchModeChange.emit(false);
  }
}
