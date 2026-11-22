import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PillDirective } from 'src/app/shared/directives/pill.directive';
import { FormatEtaPipe } from 'src/app/shared/pipes/format-eta.pipe';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import { AlertBannerComponent } from 'src/app/shared/components/alert-banner/alert-banner.component';
import { CopyToClipboardDirective } from 'src/app/shared/directives/copy-to-clipboard.directive';
import { FlowNode, WizardFlowDiagramComponent } from '../flow-diagram/flow-diagram.component';
import { IconService } from 'src/app/services/ui/icon.service';
import { shortPath } from 'src/app/shared/utils/wizard.util';
import { WizardState } from '../wizard.state';

@Component({
  selector: 'app-wizard-review-step',
  imports: [
    MatIconModule,
    MatButtonModule,
    MatSlideToggleModule,
    MatProgressBarModule,
    TranslatePipe,
    PillDirective,
    FormatEtaPipe,
    FormatFileSizePipe,
    AlertBannerComponent,
    CopyToClipboardDirective,
    WizardFlowDiagramComponent,
  ],
  templateUrl: './review-step.component.html',
  styleUrls: ['./review-step.component.scss', '../wizard-shared.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WizardReviewStepComponent {
  protected readonly state = inject(WizardState);
  private readonly iconService = inject(IconService);
  private readonly translate = inject(TranslateService);

  /** The two places of the picture: where the files are, and where they go. */
  protected readonly flow = computed<{ from: FlowNode; to: FlowNode }>(() => {
    const s = this.state;
    const p = s.plan();
    const whole = this.translate.instant('modals.wizard.review.wholeCloud');
    const cloud = (remote: string, type: string, folder: string): FlowNode => ({
      icon: this.iconService.getIconName(type),
      title: remote,
      text: folder || whole,
    });
    const here = cloud(s.remoteName(), s.remoteType(), s.cloudFolder());
    if (p?.needsSecondRemote) {
      return { from: here, to: cloud(s.targetRemote(), s.otherRemoteType(), s.targetFolder()) };
    }
    if (p?.flow === 'share') {
      const place = s.sharePlace();
      return {
        from: here,
        to: {
          icon: place.icon,
          title: this.translate.instant(`modals.wizard.places.${place.key}`),
          text: this.translate.instant('modals.wizard.places.homeNetwork'),
        },
      };
    }
    const saf = s.usesSaf();
    return {
      from: {
        icon: s.localPlaceIcon(),
        title: this.translate.instant(`modals.wizard.places.${s.localPlace()}`),
        text: saf
          ? this.translate.instant('modals.wizard.places.filesApp')
          : shortPath(s.localLabel()),
        hint: saf ? undefined : s.localLabel(),
      },
      to: here,
    };
  });
}
