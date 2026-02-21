import { Component, input, output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { CdkMenuModule } from '@angular/cdk/menu';
import { DragDropModule, CdkDragDrop, CdkDragStart } from '@angular/cdk/drag-drop';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatTableModule } from '@angular/material/table';
import { TranslateModule } from '@ngx-translate/core';
import { FormatFileSizePipe } from '@app/pipes';
import { IconService } from '@app/services';

@Component({
  selector: 'app-nautilus-view-pane',
  standalone: true,
  imports: [
    CommonModule,
    MatIconModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatButtonModule,
    CdkMenuModule,
    DragDropModule,
    ScrollingModule,
    MatTableModule,
    TranslateModule,
    FormatFileSizePipe,
  ],
  templateUrl: './nautilus-view-pane.component.html',
  styleUrls: ['./nautilus-view-pane.component.scss'],
})
export class NautilusViewPaneComponent {
  public iconService = inject(IconService);

  // --- Inputs ---
  public readonly files = input.required<any[]>();
  public readonly selection = input.required<Set<string>>();
  public readonly paneIndex = input.required<0 | 1>();
  public readonly isSplitEnabled = input.required<boolean>();
  public readonly loading = input.required<boolean>();
  public readonly error = input<string | null>(null);

  public readonly layout = input.required<'grid' | 'list'>();
  public readonly iconSize = input.required<number>();
  public readonly listRowHeight = input.required<number>();
  public readonly isDragging = input.required<boolean>();
  public readonly hoveredFolder = input<any | null>(null);
  public readonly cutItemPaths = input.required<Set<string>>();
  public readonly starredMode = input.required<boolean>();
  public readonly sortKey = input.required<string>();
  public readonly sortDirection = input.required<'asc' | 'desc'>();

  public readonly activePaneIndex = input.required<0 | 1>();

  // Custom functions passed as inputs
  public readonly getItemKey = input.required<(item: any) => string>();
  public readonly isItemSelectable = input.required<(entry: any) => boolean>();
  public readonly trackByFile = input.required<(index: number, item: any) => any>();
  public readonly trackBySortOption = input.required<(index: number, item: any) => any>();
  public readonly formatRelativeDate = input.required<(dateString: string) => string>();
  public readonly canAcceptFile = input.required<(drag: any, drop: any) => boolean>();

  public readonly displayedColumns = input<string[]>(['name', 'size', 'modified', 'star']);
  public readonly fileMenu = input.required<any>(); // Reference to the CdkMenu template

  // --- Outputs ---
  public readonly switchPane = output<0 | 1>();
  public readonly clearSelection = output<void>();
  public readonly setContextItem = output<any | null>();
  public readonly onDropToCurrentDirectory = output<{
    event: CdkDragDrop<any>;
    paneIndex: 0 | 1;
  }>();
  public readonly onDragStarted = output<CdkDragStart>();
  public readonly onDragEnded = output<void>();
  public readonly onItemClick = output<{
    item: any;
    event: Event;
    index: number;
  }>();
  public readonly navigateTo = output<any>();
  public readonly toggleStar = output<any>();
  public readonly toggleSort = output<string>();
  public readonly refresh = output<void>();
  public readonly cancelLoad = output<0 | 1>();

  isStarred(item: any): boolean {
    return item.entry.Starred === true;
  }
}
