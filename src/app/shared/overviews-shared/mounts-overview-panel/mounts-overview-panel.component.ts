import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  model,
} from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';

import { MountedRemote, Origin, matchesOriginFilter } from '@app/types';
import { MountCardComponent } from '../../components/mount-card/mount-card.component';
import { MountManagementService } from '../../../services/operations/mount-management.service';
import { NavigationDispatcherService } from '../../../services/ui/navigation-dispatcher.service';
import { PathService } from '../../../services/infrastructure/platform/path.service';
import { RemoteFacadeService } from '../../../services/facade/remote-facade.service';
import { OriginFilterBarComponent } from '../origin-filter-bar/origin-filter-bar.component';
import { PillDirective } from '../../directives/pill.directive';

@Component({
  selector: 'app-mounts-overview-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatExpansionModule,
    MatIconModule,
    TranslatePipe,
    MountCardComponent,
    OriginFilterBarComponent,
    PillDirective,
  ],
  templateUrl: './mounts-overview-panel.component.html',
  styleUrl: '../../../styles/_overview-card-panel.scss',
})
export class MountsOverviewPanelComponent {
  readonly expanded = model<boolean>(false);

  readonly defaultOriginFilter = input<Origin | 'all'>('all');
  readonly showFilterChips = input<boolean>(false);

  private readonly mountService = inject(MountManagementService);
  private readonly navigationDispatcher = inject(NavigationDispatcherService);
  private readonly remoteFacade = inject(RemoteFacadeService);
  private readonly pathService = inject(PathService);

  readonly selectedOriginFilter = linkedSignal<string>(() => this.defaultOriginFilter());

  readonly allMounts = computed(() => {
    const filter = this.selectedOriginFilter();
    return this.mountService.mountedRemotes().filter(m => matchesOriginFilter(m, filter));
  });

  onMountClick(mount: MountedRemote): void {
    this.navigationDispatcher.navigateToOwner(
      mount,
      this.pathService.getRemoteNameFromFs(mount.fs),
      'mount'
    );
  }

  onOpenMount(mount: MountedRemote): void {
    void this.remoteFacade.openRemoteInFiles(
      this.pathService.getRemoteNameFromFs(mount.fs),
      mount.mount_point
    );
  }

  onUnmount(mount: MountedRemote): void {
    void this.mountService.unmountRemote(
      mount.mount_point,
      this.pathService.getRemoteNameFromFs(mount.fs)
    );
  }
}
