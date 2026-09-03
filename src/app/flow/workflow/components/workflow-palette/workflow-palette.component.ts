import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
  output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { SearchContainerComponent } from '../../../../shared/components/search-container/search-container.component';
import { WorkflowStateService } from '../../../../services/flow/workflow-state.service';
import { NodePaletteItem, WorkflowNodeCategory } from '../../types/workflow.types';
import { PALETTE_ITEMS } from '../../constants/palette.registry';

export { PALETTE_ITEMS };

@Component({
  selector: 'app-workflow-palette',
  imports: [CommonModule, MatIconModule, MatButtonModule, TranslatePipe, SearchContainerComponent],
  templateUrl: './workflow-palette.component.html',
  styleUrl: './workflow-palette.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        overflow: hidden;
        display: flex;
        flex-direction: column;
        height: 100%;
      }
    `,
  ],
})
export class WorkflowPaletteComponent {
  private readonly stateService = inject(WorkflowStateService);
  private readonly translate = inject(TranslateService);

  readonly closePalette = output<void>();
  readonly searchQuery = signal<string>('');
  readonly selectedCategory = signal<WorkflowNodeCategory | 'all'>('all');
  readonly isSearchOpen = signal<boolean>(false);

  readonly categories: { id: WorkflowNodeCategory | 'all'; label: string; icon: string }[] = [
    { id: 'all', label: 'flow.workflow.categories.all', icon: 'grid' },
    { id: 'trigger', label: 'flow.workflow.category.trigger', icon: 'play' },
    { id: 'task', label: 'flow.workflow.category.task', icon: 'sync' },
    { id: 'logic', label: 'flow.workflow.category.logic', icon: 'flow' },
    { id: 'action', label: 'flow.workflow.category.action', icon: 'bell' },
  ];

  readonly filteredItems = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const cat = this.selectedCategory();

    return PALETTE_ITEMS.filter(item => {
      const matchCat = cat === 'all' || item.category === cat;
      if (!matchCat) return false;
      if (!query) return true;

      const title = item.titleKey ? this.translate.instant(item.titleKey) : item.title;
      const desc = item.descriptionKey
        ? this.translate.instant(item.descriptionKey)
        : item.description;

      return (
        title.toLowerCase().includes(query) ||
        desc.toLowerCase().includes(query) ||
        item.title.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.type.toLowerCase().includes(query)
      );
    });
  });

  toggleSearch(): void {
    this.isSearchOpen.update(v => !v);
  }

  onDragStart(item: NodePaletteItem, event: DragEvent): void {
    if (event.dataTransfer) {
      event.dataTransfer.setData('application/json', JSON.stringify(item));
      event.dataTransfer.effectAllowed = 'copy';
    }
  }

  addNodeToCanvas(item: NodePaletteItem): void {
    const vp = this.stateService.viewport();
    // Center node relative to current canvas camera
    const canvasX = (400 - vp.x) / vp.zoom;
    const canvasY = (300 - vp.y) / vp.zoom;
    const title = item.titleKey ? this.translate.instant(item.titleKey) : item.title;

    this.stateService.addNode(item.type, item.category, title, canvasX, canvasY, {
      icon: item.icon,
      inputs: item.defaultInputs,
      outputs: item.defaultOutputs,
      config: item.defaultConfig,
    });
  }
}
