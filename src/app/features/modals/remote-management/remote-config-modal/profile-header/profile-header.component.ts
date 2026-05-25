import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { SharedProfileType } from '@app/types';
import { RemoteConfigStateService } from '@app/services';

@Component({
  selector: 'app-profile-header',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    TranslateModule,
  ],
  templateUrl: './profile-header.component.html',
  styleUrl: './profile-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileHeaderComponent {
  readonly state = inject(RemoteConfigStateService);

  // ── Inputs ────────────────────────────────────────────────────────────────

  readonly flagType = input.required<SharedProfileType>();

  // ── Computed ───────────────────────────────────────────────────────────────

  readonly profileStateForType = computed(() => this.state.profileState()[this.flagType()]);
  readonly selectedName = computed(() => this.state.selectedProfileName()[this.flagType()]);
  readonly profileList = computed(() => this.state.profileLists()[this.flagType()]);

  readonly renameDisabled = computed(() =>
    this.state.isRenameProfileDisabled(this.flagType(), this.selectedName())
  );
  readonly deleteDisabled = computed(() =>
    this.state.isDeleteProfileDisabled(this.flagType(), this.selectedName())
  );
  readonly renameDisabledReason = computed(() =>
    this.state.getRenameProfileDisabledReason(this.flagType(), this.selectedName())
  );
  readonly deleteDisabledReason = computed(() =>
    this.state.getDeleteProfileDisabledReason(this.flagType(), this.selectedName())
  );
}
