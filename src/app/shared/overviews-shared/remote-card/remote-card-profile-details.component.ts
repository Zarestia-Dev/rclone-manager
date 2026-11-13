import { TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { PrimaryActionType } from '@app/types';
import { DetailedOperationViewModel, ProfilePathTarget, ProfileTarget } from './remote-card.types';

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
  readonly detailedOperationViewModels = input<DetailedOperationViewModel[]>([]);

  readonly profileToggle = output<ProfileTarget>();
  readonly profileOpenInFiles = output<ProfilePathTarget>();

  protected onToggle(operation: PrimaryActionType, profile: string, event: Event): void {
    event.stopPropagation();
    this.profileToggle.emit({ operation, profile });
  }

  protected onOpen(
    operation: PrimaryActionType,
    profile: string,
    path: string,
    event: Event
  ): void {
    event.stopPropagation();
    this.profileOpenInFiles.emit({ operation, profile, path });
  }
}
