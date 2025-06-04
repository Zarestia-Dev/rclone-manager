import { CommonModule } from "@angular/common";
import { Component, EventEmitter, Input, Output } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatSidenavModule } from "@angular/material/sidenav";
import { FormsModule } from "@angular/forms";
import { Remote } from "../../shared/components/types";
import { animate, state, style, transition, trigger } from "@angular/animations";
import { MatTooltipModule } from "@angular/material/tooltip";

@Component({
  selector: "app-sidebar",
  imports: [
    CommonModule,
    MatSidenavModule,
    MatCardModule,
    MatIconModule,
    FormsModule,
    MatTooltipModule
  ],
  animations: [
    trigger("slideToggle", [
      state("hidden", style({ height: "0px", opacity: 0, overflow: "hidden" })),
      state("visible", style({ height: "*", opacity: 1, overflow: "hidden" })),
      transition("hidden <=> visible", animate("300ms ease-in-out")),
    ]),
  ],
  templateUrl: "./sidebar.component.html",
  styleUrl: "./sidebar.component.scss",
})
export class SidebarComponent {
  @Input() remotes: Remote[] = [];
  @Input() iconService: any;
  @Output() remoteSelected = new EventEmitter<Remote>();

  searchTerm = "";
  searchVisible: boolean = false;

  get filteredRemotes(): Remote[] {
    const term = this.searchTerm.trim().toLowerCase();
    if (!term) return this.remotes;
    return this.remotes.filter(
      (remote) =>
        remote.remoteSpecs.name.toLowerCase().includes(term) ||
        remote.remoteSpecs.type.toLowerCase().includes(term)
    );
  }

  selectRemote(remote: Remote): void {
    this.remoteSelected.emit(remote);
  }
  toggleSearch() {
    this.searchVisible = !this.searchVisible;
  }
}
