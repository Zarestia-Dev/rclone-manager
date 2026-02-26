import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { CdkMenuModule } from '@angular/cdk/menu';

@Component({
  selector: 'app-nautilus-bottom-bar',
  standalone: true,
  imports: [CommonModule, MatIconModule, MatButtonModule, CdkMenuModule],
  templateUrl: './nautilus-bottom-bar.component.html',
  styleUrls: ['./nautilus-bottom-bar.component.scss'],
})
export class NautilusBottomBarComponent {
  // --- Inputs ---
  public readonly canGoBack = input.required<boolean>();
  public readonly canGoForward = input.required<boolean>();
  public readonly layout = input.required<'grid' | 'list'>();
  public readonly viewMenu = input.required<any>(); // Reference to the CdkMenu template

  // --- Outputs ---
  public readonly goBack = output<void>();
  public readonly goForward = output<void>();
  public readonly setLayout = output<'grid' | 'list'>();

  toggleLayout() {
    this.setLayout.emit(this.layout() === 'grid' ? 'list' : 'grid');
  }
}
