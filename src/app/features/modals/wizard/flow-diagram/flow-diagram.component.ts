import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import type { FlowDirection } from 'src/app/shared/utils/wizard.util';

/** One end of the picture: a place the files are, or go to. */
export interface FlowNode {
  readonly icon: string;
  readonly title: string;
  /** The folder, as the small print under the title. */
  readonly text: string;
  /** The full text for a `title` attribute when `text` is shortened. */
  readonly hint?: string;
}

/**
 * The review's picture: the two places and the way the files move between them. It takes the
 * colour of the surrounding `data-tone`; the label is projected above the line.
 */
@Component({
  selector: 'app-wizard-flow-diagram',
  imports: [MatIconModule],
  templateUrl: './flow-diagram.component.html',
  styleUrl: './flow-diagram.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WizardFlowDiagramComponent {
  readonly from = input.required<FlowNode>();
  readonly to = input.required<FlowNode>();
  readonly direction = input.required<FlowDirection>();
}
