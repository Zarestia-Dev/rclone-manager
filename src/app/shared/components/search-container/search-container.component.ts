import { Component, Input, Output, EventEmitter, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { AnimationsService } from '../../../services/core/animations.service';

@Component({
  selector: 'app-search-container',
  standalone: true,
  imports: [CommonModule, FormsModule, MatInputModule],
  animations: [
    AnimationsService.slideToggle(),
  ],
  template: `
    <div class="search-container" [@slideToggle]="visible ? 'visible' : 'hidden'">
      <input 
        #searchInput
        matInput 
        [(ngModel)]="searchText" 
        (ngModelChange)="onSearchTextChange($event)"
        [placeholder]="placeholder"
        [attr.aria-label]="ariaLabel"
        class="search-input" />
    </div>
  `,
  styleUrls: ['./search-container.component.scss']
})
export class SearchContainerComponent {
  @Input() visible: boolean = false;
  @Input() placeholder: string = 'Search...';
  @Input() ariaLabel: string = 'Search';
  @Input() searchText: string = '';
  
  @Output() searchTextChange = new EventEmitter<string>();
  @Output() visibilityChange = new EventEmitter<boolean>();
  
  @ViewChild('searchInput') searchInput!: ElementRef<HTMLInputElement>;

  onSearchTextChange(value: string): void {
    this.searchText = value;
    this.searchTextChange.emit(value);
  }

  focus(): void {
    // Focus after animation completes
    setTimeout(() => {
      if (this.searchInput?.nativeElement) {
        this.searchInput.nativeElement.focus();
      }
    }, 300);
  }

  clear(): void {
    this.searchText = '';
    this.onSearchTextChange('');
  }
}
