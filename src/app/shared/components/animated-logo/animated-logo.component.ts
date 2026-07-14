import { Component, ChangeDetectionStrategy } from '@angular/core';

@Component({
  selector: 'app-animated-logo',
  standalone: true,
  imports: [],
  templateUrl: './animated-logo.component.html',
  styleUrls: ['./animated-logo.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnimatedLogoComponent {}
