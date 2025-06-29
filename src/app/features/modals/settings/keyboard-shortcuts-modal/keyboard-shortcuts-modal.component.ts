import { Component, HostListener, ViewChild } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatTableModule } from "@angular/material/table";
import { SearchContainerComponent } from "../../../../shared/components/search-container/search-container.component";
import { AnimationsService } from "../../../../services/core/animations.service";

@Component({
  selector: "app-keyboard-shortcuts-modal",
  imports: [
    MatTableModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    MatButtonModule,
    SearchContainerComponent
],
  templateUrl: "./keyboard-shortcuts-modal.component.html",
  styleUrl: "./keyboard-shortcuts-modal.component.scss",
  animations: [
    AnimationsService.slideToggle(),
  ],
})
export class KeyboardShortcutsModalComponent {
  searchText = "";
  searchVisible = false; // Controls the visibility of search field
  
  @ViewChild(SearchContainerComponent) searchContainer!: SearchContainerComponent;
  
  shortcuts = [
    { keys: "Ctrl + ,", description: "Open Preferences" },
    { keys: "Ctrl + ?", description: "Show Keyboard Shortcuts" },
    { keys: "Ctrl + Q", description: "Quit Application" },
    { keys: "Ctrl + W", description: "Close Window" },
    { keys: "Ctrl + F", description: "Toggle Search Field" },
    { keys: "Ctrl + N", description: "Create New Remote (Detailed)" },
    { keys: "Ctrl + R", description: "Create New Remote (Quick)" },
    { keys: "Ctrl + O", description: "Open Remote Browser" },
    { keys: "Ctrl + S", description: "Load Configuration" },
    { keys: "Ctrl + E", description: "Export Configuration" },
    { keys: "Ctrl + L", description: "View Logs" },
    { keys: "Ctrl + T", description: "Toggle Terminal" },
    { keys: "Ctrl + D", description: "Duplicate Remote" },
    { keys: "Delete", description: "Delete Selected Remote" },
    { keys: "Escape", description: "Close Dialog/Cancel Action" },
    { keys: "Enter", description: "Confirm Action" }
  ];

  filteredShortcuts = [...this.shortcuts];

  constructor(
    private dialogRef: MatDialogRef<KeyboardShortcutsModalComponent>
  ) {}

  @HostListener("document:keydown.escape", ["$event"])
  close(event?: KeyboardEvent) {
    this.dialogRef.close();
  }

  @HostListener("document:keydown.f3", ["$event"])
  onF3(event: KeyboardEvent) {
    event.preventDefault();
    this.toggleSearch();
    if (this.searchVisible && this.searchContainer) {
      this.searchContainer.focus();
    }
  }

  toggleSearch() {
    this.searchVisible = !this.searchVisible;
    if (!this.searchVisible) {
      this.clearSearch();
    }
  }

  onSearchTextChange(searchText: string) {
    this.searchText = searchText;
    this.filterShortcuts();
  }

  filterShortcuts() {
    const searchTerm = this.searchText.toLowerCase().trim();
    
    if (!searchTerm) {
      this.filteredShortcuts = [...this.shortcuts];
      return;
    }

    this.filteredShortcuts = this.shortcuts.filter(
      (shortcut) =>
        shortcut.description.toLowerCase().includes(searchTerm) ||
        shortcut.keys.toLowerCase().includes(searchTerm) ||
        // Also search individual key parts
        shortcut.keys.split('+').some(key => 
          key.trim().toLowerCase().includes(searchTerm)
        )
    );
  }

  clearSearch() {
    this.searchText = "";
    this.filteredShortcuts = [...this.shortcuts];
    if (this.searchContainer) {
      this.searchContainer.clear();
    }
  }

  // Method to get category for a shortcut (for potential future categorization)
  getShortcutCategory(shortcut: any): string {
    const { keys, description } = shortcut;
    
    if (keys.includes('Ctrl + N') || keys.includes('Ctrl + R') || keys.includes('Ctrl + O')) {
      return 'Remote Management';
    } else if (keys.includes('Ctrl + S') || keys.includes('Ctrl + E') || keys.includes('Ctrl + L')) {
      return 'File Operations';
    } else if (keys.includes('Ctrl + C') || keys.includes('Ctrl + V') || keys.includes('Ctrl + X')) {
      return 'Clipboard';
    } else if (keys.includes('Tab') || keys.includes('Escape') || keys.includes('Enter')) {
      return 'Navigation';
    } else if (keys.includes('Ctrl + ,') || keys.includes('Ctrl + ?')) {
      return 'Application';
    }
    
    return 'General';
  }
}
