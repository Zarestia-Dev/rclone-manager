import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { EditTarget } from '@app/types';
import { RemoteConfigStateService } from '@app/services';

@Component({
  selector: 'app-config-modal-sidebar',
  standalone: true,
  imports: [
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatListModule,
    MatTooltipModule,
    TranslateModule,
  ],
  templateUrl: './config-modal-sidebar.component.html',
  styleUrl: './config-modal-sidebar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfigModalSidebarComponent {
  readonly state = inject(RemoteConfigStateService);

  // ── Inputs ────────────────────────────────────────────────────────────────

  readonly remoteEditCategories = input<readonly { id: string; label: string; icon: string }[]>([]);
  readonly visibleSections = input<Set<string>>(new Set());
  readonly profileIcons = input<Readonly<Record<string, string>>>({});

  // ── Outputs ───────────────────────────────────────────────────────────────

  readonly stepSelected = output<number>();
  readonly sectionScrolled = output<string>();
  readonly profileSelected = output<{ type: EditTarget; name: string }>();
  readonly sharedNavigated = output<EditTarget>();
  readonly returnFromShared = output<void>();
  readonly cliImportToggled = output<void>();

  // ── Template helpers ──────────────────────────────────────────────────────

  isStepDisabled(step: number): boolean {
    if (this.state.isStepNavigationLocked()) return true;
    if (step > this.state.currentStep()) {
      if (this.state.isActiveStepInvalid()) return true;
      if (!this.state.editTarget() && this.state.remoteFormStatus?.() === 'INVALID') return true;
    }
    return false;
  }
}
