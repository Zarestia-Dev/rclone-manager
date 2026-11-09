import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { CdkMenuModule } from '@angular/cdk/menu';
import { TranslatePipe } from '@ngx-translate/core';
import { OpenableFolder, PrimaryActionType, QuickActionButton } from '@app/types';
import { FolderBrowseButtonComponent } from '../../components/folder-browse-button/folder-browse-button.component';
import { PillDirective } from '../../directives/pill.directive';
import { ProfilePickerGroup, ProfileTarget } from './remote-card.types';

@Component({
  selector: 'app-remote-card-actions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule,
    MatButtonModule,
    CdkMenuModule,
    TranslatePipe,
    PillDirective,
    FolderBrowseButtonComponent,
  ],
  templateUrl: './remote-card-actions.component.html',
  styleUrls: ['./remote-card-actions.component.scss', '../../../styles/_shared-card.scss'],
  host: {
    style: 'display: contents',
  },
})
export class RemoteCardActionsComponent {
  readonly actionButtons = input<QuickActionButton[]>([]);
  /** Profile menus by operation; an operation without one starts or stops directly. */
  readonly profilePickers = input<Record<string, ProfilePickerGroup>>({});
  readonly openableFolders = input<OpenableFolder[]>([]);

  readonly actionClick = output<PrimaryActionType>();
  readonly profilePick = output<ProfileTarget>();
  readonly openFolder = output<OpenableFolder>();

  protected onAction(id: string, event: Event): void {
    event.stopPropagation();
    this.actionClick.emit(id as PrimaryActionType);
  }

  protected onPick(operation: PrimaryActionType, profile: string, event: Event): void {
    event.stopPropagation();
    this.profilePick.emit({ operation, profile });
    (event.currentTarget as HTMLElement | null)?.blur();
  }
}
