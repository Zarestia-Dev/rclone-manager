import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';
import { SharedProfileType } from '@app/types';
import { RemoteConfigStateService } from 'src/app/services/remote/remote-config-state.service';

@Component({
  selector: 'app-profile-switcher',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    TranslatePipe,
  ],
  templateUrl: './profile-switcher.component.html',
  styleUrl: './profile-switcher.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileSwitcherComponent {
  readonly state = inject(RemoteConfigStateService);
  readonly flagType = input.required<SharedProfileType>();

  readonly profileStateForType = computed(() => this.state.profileState()[this.flagType()]);
  readonly selectedName = computed(() => this.state.selectedProfileName()[this.flagType()]);
  readonly profileList = computed(() => this.state.profileLists()[this.flagType()]);

  readonly deleteStateForProfile = computed(() => {
    const list = this.profileList() ?? [];
    const t = this.flagType();
    const map: Record<string, { disabled: boolean; reason: string }> = {};
    for (const p of list) {
      map[p.name] = this.state.getProfileActionState(t, p.name).delete;
    }
    return map;
  });

  private readonly headerActionState = computed(() =>
    this.state.getProfileActionState(this.flagType(), this.selectedName() ?? '')
  );
  readonly renameDisabled = computed(() => this.headerActionState().rename.disabled);
  readonly renameDisabledReason = computed(() => this.headerActionState().rename.reason);

  // ── Helpers used by the template ───────────────────────────────────────────

  deleteDisabledFor(name: string): boolean {
    return this.deleteStateForProfile()[name]?.disabled ?? false;
  }
  deleteReasonFor(name: string): string {
    return this.deleteStateForProfile()[name]?.reason ?? '';
  }
}
