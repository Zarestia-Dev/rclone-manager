import { Component, inject, viewChild, ElementRef, input, output, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { CdkMenuModule } from '@angular/cdk/menu';
import { DragDropModule, CdkDrag, CdkDragDrop } from '@angular/cdk/drag-drop';
import { IconService } from '@app/services';
import { ExplorerRoot, FileBrowserItem } from '@app/types';

@Component({
  selector: 'app-nautilus-toolbar',
  standalone: true,
  imports: [
    CommonModule,
    MatToolbarModule,
    MatButtonModule,
    MatIconModule,
    TranslateModule,
    CdkMenuModule,
    DragDropModule,
  ],
  templateUrl: './nautilus-toolbar.component.html',
  styleUrls: ['./nautilus-toolbar.component.scss'],
})
export class NautilusToolbarComponent {
  public readonly iconService = inject(IconService);

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
  public readonly pathOptionsMenu = input<any>();
  public readonly viewMenu = input<any>();
  public readonly canAcceptFile = input<(item: CdkDrag<FileBrowserItem>) => boolean>();

  // --- Outputs ---
  public readonly goBack = output<void>();
  public readonly goForward = output<void>();
  public readonly toggleSidebar = output<void>();
  public readonly navigateToSegment = output<number>();
  public readonly updatePath = output<string>();
  public readonly navigateToPath = output<string>();
  public readonly layoutChange = output<'grid' | 'list'>();
  public readonly closeOverlay = output<void>();

  public readonly searchFilterChange = output<string>();
  public readonly isSearchModeChange = output<boolean>();
  public readonly isEditingPathChange = output<boolean>();
  public readonly droppedOnSegment = output<CdkDragDrop<any>>();

  public readonly pathScrollView = viewChild<ElementRef<HTMLDivElement>>('pathScrollView');
  public readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  public readonly pathInput = viewChild<ElementRef<HTMLInputElement>>('pathInput');

  constructor() {
    effect(() => {
      // Track pathSegments so the scroll effect triggers whenever folders change
      this.pathSegments();
      this.scrollToEnd();
    });

    effect(() => {
      if (this.isEditingPath()) {
        setTimeout(() => this.pathInput()?.nativeElement.select(), 10);
      }
    });

    effect(() => {
      if (this.isSearchMode()) {
        setTimeout(() => {
          this.searchInput()?.nativeElement.focus();
          this.searchInput()?.nativeElement.select();
        }, 10);
      }
    });
  }

  private scrollToEnd(): void {
    const el = this.pathScrollView()?.nativeElement;
    if (el) {
      setTimeout(() => {
        el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
      }, 50);
    }
  }

  public onPathScroll(event: WheelEvent): void {
    const el = this.pathScrollView()?.nativeElement;
    if (el) {
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  }

  public onSearchEscape(inputElement: HTMLInputElement): void {
    this.searchFilterChange.emit('');
    this.isSearchModeChange.emit(false);
    inputElement.blur();
  }

  public onSearchBlur(): void {
    if (!this.searchFilter().trim()) {
      this.isSearchModeChange.emit(false);
    }
  }

  public onPathContainerClick(): void {
    if (!this.isSearchMode()) {
      this.isEditingPathChange.emit(true);
    }
  }

  /** Fallback predicate — accepts everything when no canAcceptFile is provided. */
  public readonly _acceptAll = () => true;

  public onPathContainerEscape(): void {
    this.isEditingPathChange.emit(false);
    this.isSearchModeChange.emit(false);
  }
}
