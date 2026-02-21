import { Component, inject, ViewChild, ElementRef, input, output, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { CdkMenuModule } from '@angular/cdk/menu';
import { IconService } from '@app/services';
import { ExplorerRoot } from '@app/types';

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
  public readonly pathSegments = input.required<string[]>();
  public readonly isDragging = input.required<boolean>();
  public readonly hoveredSegmentIndex = input.required<number | null>();
  public readonly fullPathInput = input.required<string>();
  public readonly layout = input.required<'grid' | 'list'>();
  public readonly pathOptionsMenu = input<any>();
  public readonly viewMenu = input<any>();

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

  @ViewChild('pathScrollView') pathScrollView?: ElementRef<HTMLDivElement>;
  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;
  @ViewChild('pathInput') pathInput?: ElementRef<HTMLInputElement>;

  constructor() {
    effect(() => {
      this.scrollToEnd();
    });

    effect(() => {
      if (this.isEditingPath()) {
        setTimeout(() => this.pathInput?.nativeElement?.select(), 10);
      }
    });

    effect(() => {
      if (this.isSearchMode()) {
        setTimeout(() => {
          this.searchInput?.nativeElement?.focus();
          this.searchInput?.nativeElement?.select();
        }, 10);
      }
    });
  }

  private scrollToEnd(): void {
    if (this.pathScrollView) {
      setTimeout(() => {
        if (this.pathScrollView?.nativeElement) {
          const el = this.pathScrollView.nativeElement;
          el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
        }
      }, 50);
    }
  }

  public onPathScroll(event: WheelEvent): void {
    if (this.pathScrollView?.nativeElement) {
      this.pathScrollView.nativeElement.scrollLeft += event.deltaY;
      event.preventDefault();
    }
  }

  public onSearchEscape(inputElement: HTMLInputElement): void {
    this.isSearchModeChange.emit(false);
    inputElement.blur();
  }

  public onPathContainerClick(): void {
    if (!this.isSearchMode()) {
      this.isEditingPathChange.emit(true);
    }
  }

  public onPathContainerEscape(): void {
    this.isEditingPathChange.emit(false);
    this.isSearchModeChange.emit(false);
  }
}
