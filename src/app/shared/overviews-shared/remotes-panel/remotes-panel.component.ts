import { Component, computed, input, output } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { RemoteCardComponent } from '../remote-card/remote-card.component';
import { AppTab, PrimaryActionType, Remote, CardDisplayMode } from '@app/types';

@Component({
  selector: 'app-remotes-panel',
  imports: [
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    TranslateModule,
    DragDropModule,
    RemoteCardComponent,
  ],
  templateUrl: './remotes-panel.component.html',
  styleUrl: './remotes-panel.component.scss',
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
  openInFiles = output<{ remoteName: string; path?: string }>();
  startJob = output<{ type: PrimaryActionType; remoteName: string; profileName?: string }>();
  stopJob = output<{ type: PrimaryActionType; remoteName: string; profileName?: string }>();
  layoutChanged = output<string[]>();
  toggleHidden = output<string>();

  // Shows all remotes in edit mode, only visible ones otherwise
  readonly displayRemotes = computed(() =>
    this.isEditingLayout() ? this.allRemotes() : this.remotes()
  );

  // Always shows the visible count, not the edit-mode count
  readonly count = computed(() => this.remotes().length);

  readonly hiddenSet = computed(() => new Set(this.hiddenRemoteNames()));

  onDrop(event: CdkDragDrop<Remote[]>): void {
    if (!this.isEditingLayout()) return;
    const names = this.displayRemotes().map(r => r.name);
    moveItemInArray(names, event.previousIndex, event.currentIndex);
    this.layoutChanged.emit(names);
  }
}
