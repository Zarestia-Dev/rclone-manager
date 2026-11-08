import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { Starter } from '@app/types';

/** Names what started a job, mount or serve: its profile, Quick Run or workflow. */
@Component({
  selector: 'app-starter-pill',
  imports: [MatIconModule],
  templateUrl: './starter-pill.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StarterPillComponent {
  readonly starter = input<Starter | undefined>();

  protected readonly pill = computed(() => {
    const starter = this.starter();
    switch (starter?.kind) {
      case 'profile':
        return { name: starter.name, icon: null };
      case 'quick_run':
        return { name: starter.name, icon: 'quick-run' };
      case 'workflow':
        return { name: starter.workflowName, icon: 'workflow' };
      case undefined:
        return null;
    }
  });
}
