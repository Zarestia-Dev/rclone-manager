import {
  animate,
  state,
  style,
  transition,
  trigger,
} from "@angular/animations";

import { Component, HostListener } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatDialogRef } from "@angular/material/dialog";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatTableModule } from "@angular/material/table";

@Component({
  selector: "app-keyboard-shortcuts-modal",
  imports: [
    MatTableModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    MatButtonModule
],
  templateUrl: "./keyboard-shortcuts-modal.component.html",
  styleUrl: "./keyboard-shortcuts-modal.component.scss",
  animations: [
    trigger("slideToggle", [
      state("hidden", style({ height: "0px", opacity: 0, overflow: "hidden" })),
      state("visible", style({ height: "*", opacity: 1, overflow: "hidden" })),
      transition("hidden <=> visible", animate("300ms ease-in-out")),
    ]),
  ],
})
export class KeyboardShortcutsModalComponent {
  searchText = "";
  searchVisible = false; // Controls the visibility of search field
  shortcuts = [
    { keys: "Ctrl + ,", description: "Preferences" },
    { keys: "Ctrl + ?", description: "Show Shortcuts" },
    { keys: "Ctrl + Q / Ctrl + W", description: "Quit" },
    { keys: "Ctrl + F / F3", description: "Toggle Search Field" },
    { keys: "Ctrl + N", description: "New Detailed Remote" },
    { keys: "Ctrl + R", description: "New Quick Remote" },
    { keys: "Ctrl + O", description: "Open Remote" },
    { keys: "Ctrl + S", description: "Save" },
  ];

  filteredShortcuts = [...this.shortcuts];

  constructor(
    private dialogRef: MatDialogRef<KeyboardShortcutsModalComponent>
  ) {}

  @HostListener("document:keydown.escape", ["$event"])
  close(event?: KeyboardEvent) {
    this.dialogRef.close();
  }

  toggleSearch() {
    this.searchVisible = !this.searchVisible;
  }

  filterShortcuts() {
    this.filteredShortcuts = this.shortcuts.filter(
      (shortcut) =>
        shortcut.description
          .toLowerCase()
          .includes(this.searchText.toLowerCase()) ||
        shortcut.keys.toLowerCase().includes(this.searchText.toLowerCase())
    );
  }
}
