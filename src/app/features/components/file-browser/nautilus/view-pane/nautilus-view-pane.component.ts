import { Component, input, output, inject, TemplateRef } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatButtonModule } from '@angular/material/button';
import { CdkMenuModule } from '@angular/cdk/menu';
import {
  DragDropModule,
  CdkDragDrop,
  CdkDragEnd,
  CdkDragStart,
  CdkDrag,
  CdkDropList,
} from '@angular/cdk/drag-drop';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatTableModule } from '@angular/material/table';
import { TranslateModule } from '@ngx-translate/core';
import { FormatFileSizePipe } from '@app/pipes';
import { IconService, NautilusService } from '@app/services';
import { Entry, FileBrowserItem } from '@app/types';

@Component({
  selector: 'app-nautilus-view-pane',
  standalone: true,
  imports: [
    NgTemplateOutlet,
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
  styleUrl: './nautilus-view-pane.component.scss',
})
export class NautilusViewPaneComponent {
  private readonly nautilusService = inject(NautilusService);
  protected readonly iconService = inject(IconService);

  // --- Inputs ---
  public readonly files = input.required<FileBrowserItem[]>();
  public readonly selection = input.required<Set<string>>();
  public readonly paneIndex = input.required<0 | 1>();
  public readonly isSplitEnabled = input.required<boolean>();
  public readonly loading = input.required<boolean>();
  public readonly error = input<string | null>(null);

  public readonly layout = input.required<'grid' | 'list'>();
  public readonly iconSize = input.required<number>();
  public readonly listRowHeight = input.required<number>();
  public readonly isDragging = input.required<boolean>();
  public readonly hoveredFolder = input<FileBrowserItem | null>(null);
  public readonly cutItemPaths = input.required<Set<string>>();
  public readonly starredMode = input.required<boolean>();
  public readonly sortKey = input.required<string>();
  public readonly sortDirection = input.required<'asc' | 'desc'>();

  public readonly activePaneIndex = input.required<0 | 1>();

  // Custom functions passed as inputs
  public readonly getItemKey = input.required<(item: FileBrowserItem) => string>();
  public readonly isItemSelectable = input.required<(entry: Entry) => boolean>();
  public readonly trackByFile = input.required<(index: number, item: FileBrowserItem) => string>();
  public readonly formatRelativeDate = input.required<(dateString: string) => string>();
  public readonly canAcceptFile =
    input.required<(drag: CdkDrag<FileBrowserItem>, drop: CdkDropList<any>) => boolean>();

  public readonly displayedColumns = input<string[]>(['name', 'size', 'modified', 'star']);
  public readonly fileMenu = input.required<TemplateRef<unknown>>(); // Reference to the CdkMenu template

  // --- Outputs ---
  public readonly switchPane = output<0 | 1>();
  public readonly clearSelection = output<void>();
  public readonly setContextItem = output<FileBrowserItem | null>();
  public readonly dropToCurrentDirectory = output<{
    event: CdkDragDrop<FileBrowserItem[]>;
    paneIndex: 0 | 1;
  }>();
  public readonly dragStarted = output<CdkDragStart<FileBrowserItem>>();
  public readonly dragEnded = output<CdkDragEnd<FileBrowserItem>>();
  public readonly itemClick = output<{
    item: FileBrowserItem;
    event: Event;
    index: number;
  }>();
  public readonly navigateTo = output<FileBrowserItem>();
  public readonly toggleStar = output<FileBrowserItem>();
  public readonly toggleSort = output<string>();
  public readonly refresh = output<void>();
  public readonly cancelLoad = output<0 | 1>();

  isStarred(item: FileBrowserItem): boolean {
    const remote = item.meta.remote || '';
    return this.nautilusService.isSaved('starred', remote, item.entry.Path, item.meta.isLocal);
  }
}
