import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslatePipe } from '@ngx-translate/core';
import { EditTarget } from '@app/types';
import { RemoteConfigStateService } from 'src/app/services/remote/remote-config-state.service';

@Component({
  selector: 'app-config-modal-sidebar',
  imports: [
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatListModule,
    MatTooltipModule,
    TranslatePipe,
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
  readonly obscureToolToggled = output<void>();

  // ── Template helpers ──────────────────────────────────────────────────────

  isStepDisabled(step: number): boolean {
    return !this.state.isStepClickable(step);
  }
}
