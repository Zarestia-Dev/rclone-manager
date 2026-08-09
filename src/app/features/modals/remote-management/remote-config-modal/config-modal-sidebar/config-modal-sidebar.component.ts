import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { TranslatePipe } from '@ngx-translate/core';
import { EditTarget, TemplateCategory } from '@app/types';
import { RemoteConfigStateService } from 'src/app/services/remote/remote-config-state.service';
import {
  PresetTemplateBarComponent,
  ApplyTemplateEvent,
} from 'src/app/shared/remote-config/preset-template-bar/preset-template-bar.component';

@Component({
  selector: 'app-config-modal-sidebar',
  imports: [
    MatButtonModule,
    MatDividerModule,
    MatIconModule,
    MatListModule,
    TranslatePipe,
    PresetTemplateBarComponent,
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
  readonly currentValues = input<Partial<Record<TemplateCategory, Record<string, unknown>>>>({});

  // ── Outputs ───────────────────────────────────────────────────────────────

  readonly stepSelected = output<number>();
  readonly sectionScrolled = output<string>();
  readonly profileSelected = output<{ type: EditTarget; name: string }>();
  readonly sharedNavigated = output<EditTarget>();
  readonly returnFromShared = output<void>();
  readonly searchToggled = output<void>();
  readonly cliImportToggled = output<void>();
  readonly obscureToolToggled = output<void>();
  readonly presetsApplied = output<void>();
  readonly defaultPresetsApplied = output<void>();
  readonly templateApplied = output<ApplyTemplateEvent>();

  // ── Template helpers ──────────────────────────────────────────────────────

  isStepDisabled(step: number): boolean {
    return !this.state.isStepClickable(step);
  }
}
