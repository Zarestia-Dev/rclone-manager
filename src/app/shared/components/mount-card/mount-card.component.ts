import { Component, computed, inject, input, output, ChangeDetectionStrategy } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { TranslatePipe } from '@ngx-translate/core';
import { MountedRemote, OPERATION_TONE } from '@app/types';
import { PathService } from 'src/app/services/infrastructure/platform/path.service';
import { CopyToClipboardDirective } from '../../directives/copy-to-clipboard.directive';
import { StarterPillComponent } from '../starter-pill/starter-pill.component';
import { PillDirective } from '../../directives/pill.directive';

@Component({
  selector: 'app-mount-card',
  imports: [
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    TranslatePipe,
    CopyToClipboardDirective,
    StarterPillComponent,
    PillDirective,
  ],
  templateUrl: './mount-card.component.html',
  styleUrl: './mount-card.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MountCardComponent {
  private readonly pathService = inject(PathService);

  readonly mount = input.required<MountedRemote>();

  readonly unmount = output<MountedRemote>();
  readonly openMount = output<MountedRemote>();
  readonly cardClick = output<MountedRemote>();

  protected readonly tone = OPERATION_TONE['mount'];

  protected readonly remoteName = computed(() =>
    this.pathService.getRemoteNameFromFs(this.mount().fs)
  );

  protected readonly mountedOn = computed(() => {
    const time = Date.parse(this.mount().mounted_on ?? '');
    return Number.isNaN(time) ? null : new Date(time).toLocaleString();
  });
}
