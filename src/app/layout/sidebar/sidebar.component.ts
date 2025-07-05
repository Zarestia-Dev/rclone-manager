import { CommonModule } from "@angular/common";
import {
  Component,
  EventEmitter,
  HostListener,
  Input,
  Output,
  ViewChild,
} from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatIconModule } from "@angular/material/icon";
import { MatSidenavModule } from "@angular/material/sidenav";
import { FormsModule } from "@angular/forms";
import { Remote } from "../../shared/components/types";
import { MatTooltipModule } from "@angular/material/tooltip";
import { AnimationsService } from "../../services/core/animations.service";
import { SearchContainerComponent } from "../../shared/components/search-container/search-container.component";

@Component({
  selector: "app-sidebar",
  imports: [
    CommonModule,
    MatSidenavModule,
    MatCardModule,
    MatIconModule,
    FormsModule,
    MatTooltipModule,
    SearchContainerComponent,
  ],
  animations: [AnimationsService.slideToggle()],
  templateUrl: "./sidebar.component.html",
  styleUrl: "./sidebar.component.scss",
})
export class SidebarComponent {
  @Input() remotes: Remote[] = [];
  @Input() iconService: any;
  @Output() remoteSelected = new EventEmitter<Remote>();

  searchTerm = "";
  searchVisible = false;
  @ViewChild(SearchContainerComponent)
  searchContainer!: SearchContainerComponent;

  onSearchTextChange(searchText: string) {
    this.searchTerm = searchText.trim().toLowerCase();
  }

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

  @HostListener("document:keydown.control.f", ["$event"])
  onControlF(event: KeyboardEvent) {
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

  clearSearch() {
    this.searchTerm = "";
    if (this.searchContainer) {
      this.searchContainer.clear();
    }
  }
}
