import { TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { PrimaryActionType } from '@app/types';
import {
  DetailedOperationViewModel,
  ProfileChipClickEvent,
  ProfileOpenInFilesEvent,
} from './remote-card.types';

import { PillDirective } from '../../directives/pill.directive';
@Component({
  selector: 'app-remote-card-profile-details',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TitleCasePipe, MatIconModule, TranslatePipe, PillDirective],
  templateUrl: './remote-card-profile-details.component.html',
  styleUrls: ['./remote-card-profile-details.component.scss'],
})
export class RemoteCardProfileDetailsComponent {
  readonly detailedOperations = input<PrimaryActionType[]>([]);
  readonly detailedOperationViewModels = input<DetailedOperationViewModel[]>([]);

  readonly profileChipClick = output<ProfileChipClickEvent>();
  readonly profileOpenInFiles = output<ProfileOpenInFilesEvent>();

  onProfileChipClick(operation: PrimaryActionType, profile: string, event: Event): void {
    this.profileChipClick.emit({ operation, profile, event });
  }

  onProfileOpenInFiles(
    operation: PrimaryActionType,
    profile: string,
    path: string,
    event: Event
  ): void {
    this.profileOpenInFiles.emit({ operation, profile, path, event });
  }
}
