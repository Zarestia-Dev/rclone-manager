import { Component, computed, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
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
  imports: [
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    TranslateModule,
    DragDropModule,
    RemoteCardComponent,
  ],
  templateUrl: './remotes-panel.component.html',
  styleUrl: './remotes-panel.component.scss',
  host: {
    class: 'remotes-panel',
    '[class.active-remotes-panel]': 'isActive()',
    '[attr.aria-label]': 'title()',
  },
})
export class RemotesPanelComponent {
  title = input('');
  icon = input('');
  isActive = input(false);
  remotes = input<Remote[]>([]);
  allRemotes = input<Remote[]>([]);
  hiddenRemoteNames = input<string[]>([]);
  isEditingLayout = input(false);
  mode = input<AppTab>('general');
  displayMode = input<CardDisplayMode>('compact');
  primaryActionLabel = input('Start');
  activeIcon = input('circle-check');

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
