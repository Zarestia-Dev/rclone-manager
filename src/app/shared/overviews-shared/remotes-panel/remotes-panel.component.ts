import { Component, computed, input, model, output, ChangeDetectionStrategy } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { RemoteCardComponent } from '../remote-card/remote-card.component';
import {
  AppTab,
  Remote,
  CardDisplayMode,
  StartJobEvent,
  StopJobEvent,
  OpenInFilesEvent,
} from '@app/types';

@Component({
  selector: 'app-remotes-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatExpansionModule,
    MatIconModule,
    MatButtonModule,
    DragDropModule,
    RemoteCardComponent,
  ],
  templateUrl: './remotes-panel.component.html',
  styleUrl: './remotes-panel.component.scss',
  host: {
    class: 'remotes-panel-host',
    '[class.active-remotes-panel]': 'isActive()',
    '[attr.aria-label]': 'title()',
  },
})
export class RemotesPanelComponent {
  readonly expanded = model(true);

  readonly title = input('');
  readonly icon = input('');
  readonly isActive = input(false);
  readonly remotes = input<Remote[]>([]);
  readonly allRemotes = input<Remote[]>([]);
  readonly hiddenRemoteNames = input<string[]>([]);
  readonly isEditingLayout = input(false);
  readonly mode = input<AppTab>('general');
  readonly displayMode = input<CardDisplayMode>('compact');
  readonly primaryActionLabel = input('Start');
  readonly activeIcon = input('check-circle');

  remoteSelected = output<Remote>();
  openInFiles = output<OpenInFilesEvent>();
  startJob = output<StartJobEvent>();
  stopJob = output<StopJobEvent>();
  layoutChanged = output<string[]>();
  toggleHidden = output<string>();

  readonly hiddenSet = computed(() => new Set(this.hiddenRemoteNames()));

  readonly displayRemotes = computed(() =>
    this.isEditingLayout() ? this.allRemotes() : this.remotes()
  );

  readonly count = computed(() => this.remotes().length);

  onDrop(event: CdkDragDrop<Remote[]>): void {
    if (!this.isEditingLayout()) return;
    const names = this.displayRemotes().map(r => r.name);
    moveItemInArray(names, event.previousIndex, event.currentIndex);
    this.layoutChanged.emit(names);
  }
}
