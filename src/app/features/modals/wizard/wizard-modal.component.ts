import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslatePipe } from '@ngx-translate/core';
import { EscapeCloseDirective } from 'src/app/shared/directives/escape-close.directive';
import { FormatEtaPipe } from 'src/app/shared/pipes/format-eta.pipe';
import { FormatFileSizePipe } from 'src/app/shared/pipes/format-file-size.pipe';
import { WizardState } from './wizard.state';
import { WizardSettingsPanelComponent } from './settings-panel.component';
import { WizardGoalStepComponent } from './steps/goal-step.component';
import { WizardQuestionStepComponent } from './steps/question-step.component';
import { WizardWhereStepComponent } from './steps/where-step.component';
import { WizardWhenStepComponent } from './steps/when-step.component';
import { WizardReviewStepComponent } from './steps/review-step.component';
import { WizardDoneStepComponent } from './steps/done-step.component';

/**
 * "What do you want to do?": the frame of the wizard. It asks in everyday words, shows what will
 * happen with the user's own numbers, then sets the operation up and starts it. The steps are
 * components of their own; what they share lives in `WizardState`.
 */
@Component({
  selector: 'app-wizard-modal',
  hostDirectives: [EscapeCloseDirective],
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    TranslatePipe,
    FormatEtaPipe,
    FormatFileSizePipe,
    WizardSettingsPanelComponent,
    WizardGoalStepComponent,
    WizardQuestionStepComponent,
    WizardWhereStepComponent,
    WizardWhenStepComponent,
    WizardReviewStepComponent,
    WizardDoneStepComponent,
  ],
  providers: [WizardState],
  templateUrl: './wizard-modal.component.html',
  styleUrls: [
    './wizard-modal.component.scss',
    './wizard-shared.scss',
    '../../../styles/_shared-modal.scss',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WizardModalComponent implements OnInit {
  protected readonly state = inject(WizardState);

  /** The bar says how far along the questions are; it has nothing to say when the list is empty. */
  protected readonly showsProgress = computed(() => {
    const s = this.state;
    return (
      !s.isLoading() &&
      !s.loadFailed() &&
      s.remotes().length > 0 &&
      s.step() !== 'done' &&
      !s.settingsOpen()
    );
  });

  /** Only the steps that go somewhere have buttons; the first screen's cards are its buttons. */
  protected readonly hasFooter = computed(() => {
    const s = this.state;
    if (s.isLoading() || s.loadFailed() || !s.remotes().length) return false;
    return s.settingsOpen() || ['question', 'where', 'when', 'review'].includes(s.step());
  });

  ngOnInit(): void {
    this.state.init();
  }
}
