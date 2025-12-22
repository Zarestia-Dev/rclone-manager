import {
  Component,
  Input,
  Output,
  EventEmitter,
  ViewChild,
  ElementRef,
  OnChanges,
  SimpleChanges,
} from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';

@Component({
  selector: 'app-search-container',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatIconModule],
  template: `
    <div class="search-container" [class.visible]="visible">
      <mat-form-field subscriptSizing="dynamic">
        <mat-icon matPrefix svgIcon="search"></mat-icon>
        <input
          #searchInput
          matInput
          [(ngModel)]="searchText"
          (ngModelChange)="onSearchTextChange($event)"
          [placeholder]="placeholder"
          [attr.aria-label]="ariaLabel"
        />
      </mat-form-field>
    </div>
  `,
  styleUrls: ['./search-container.component.scss'],
})
export class SearchContainerComponent implements OnChanges {
  @Input() visible = false;
  @Input() placeholder = 'Search...';
  @Input() ariaLabel = 'Search';
  @Input() searchText = '';

  @Output() searchTextChange = new EventEmitter<string>();

  @ViewChild('searchInput') searchInput!: ElementRef<HTMLInputElement>;

  ngOnChanges(changes: SimpleChanges): void {
    // Check if the 'visible' property is the one that changed
    if (changes['visible']) {
      // If it changed to true, call the focus method
      if (changes['visible'].currentValue === true) {
        this.focus();
      }
    }
  }

  onSearchTextChange(value: string): void {
    this.searchText = value;
    this.searchTextChange.emit(value);
  }

  public focus(): void {
    setTimeout(() => {
      this.searchInput?.nativeElement?.focus();
    }, 150);
  }

  public clear(): void {
    this.searchText = '';
    this.onSearchTextChange('');
  }
}
