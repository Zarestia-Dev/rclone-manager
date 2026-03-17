import {
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-search-container',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatIconModule, TranslateModule],
  template: `
    <div class="search-container" [class.visible]="visible()">
      <mat-form-field subscriptSizing="dynamic">
        <mat-icon matPrefix svgIcon="search"></mat-icon>
        <input
          #searchInput
          matInput
          [ngModel]="searchText()"
          (ngModelChange)="searchTextChange.emit($event)"
          [placeholder]="placeholder() | translate"
          [attr.aria-label]="ariaLabel() | translate"
        />
      </mat-form-field>
    </div>
  `,
  styleUrls: ['./search-container.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchContainerComponent {
  visible = input(false);
  placeholder = input('shared.search.placeholder');
  ariaLabel = input('shared.search.ariaLabel');
  searchText = input('');

  searchTextChange = output<string>();

  searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  constructor() {
    effect(() => {
      if (this.visible()) {
        this.focus();
      }
    });
  }

  focus(): void {
    setTimeout(() => {
      this.searchInput()?.nativeElement?.focus();
    }, 150);
  }

  clear(): void {
    this.searchTextChange.emit('');
  }
}
