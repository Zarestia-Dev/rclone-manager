import { CommonModule } from "@angular/common";
import { Component, EventEmitter, Input, Output } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatSidenavModule } from "@angular/material/sidenav";
import { FormsModule } from "@angular/forms";
import { Remote } from "../../shared/components/types";
import { MatTooltipModule } from "@angular/material/tooltip";
import { AnimationsService } from "../../shared/animations/animations.service";

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
    AnimationsService.slideToggle(),
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
