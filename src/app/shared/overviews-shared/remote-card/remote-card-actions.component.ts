import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe } from '@ngx-translate/core';
import { OpenableFolder, PrimaryActionType, QuickActionButton } from '@app/types';
import {
  ActionButtonClickEvent,
  OpenFolderClickEvent,
  ProfilePickerClickEvent,
  ProfilePickerGroup,
} from './remote-card.types';

@Component({
  selector: 'app-remote-card-actions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, MatButtonModule, CdkMenuModule, TranslatePipe],
  templateUrl: './remote-card-actions.component.html',
  styleUrls: ['../../../styles/_shared-card.scss'],
  host: {
    style: 'display: contents',
  },
})
export class RemoteCardActionsComponent {
  readonly actionButtons = input<QuickActionButton[]>([]);
  readonly profilePickerGroupByOp = input<Record<string, ProfilePickerGroup>>({});
  readonly openableFolders = input<OpenableFolder[]>([]);
  readonly folderBlossomStyle = input<Record<string, string> | null>(null);
  readonly isFolderOpening = input<boolean>(false);

  readonly actionClick = output<ActionButtonClickEvent>();
  readonly profilePickerClick = output<ProfilePickerClickEvent>();
  readonly openFolderClick = output<OpenFolderClickEvent>();

  onActionButtonClick(action: ActionButtonClickEvent): void {
    this.actionClick.emit(action);
  }

  onProfilePickerClick(operation: PrimaryActionType, profile: string, event: Event): void {
    this.profilePickerClick.emit({ operation, profile, event });
  }

  onOpenFolderClick(folder: OpenableFolder, event: Event): void {
    this.openFolderClick.emit({ folder, event });
  }
}
