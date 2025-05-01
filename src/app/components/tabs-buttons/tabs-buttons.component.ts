import { Component } from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { StateService } from "../../services/state.service";
import { MatButtonModule } from "@angular/material/button";

@Component({
  selector: "app-tabs-buttons",
  imports: [MatIconModule, MatButtonModule],
  templateUrl: "./tabs-buttons.component.html",
  styleUrl: "./tabs-buttons.component.scss",
})
export class TabsButtonsComponent {
  currentTab: "mount" | "sync" | "copy" | "jobs" = "mount";

  constructor(private stateService: StateService) {}
  setTab(tab: "mount" | "sync" | "copy" | "jobs") {
    this.stateService.setTab(tab);
    this.currentTab = tab;
  }

  ngOnInit() {
    this.stateService.currentTab$.subscribe((tab) => {
      this.currentTab = tab;
    });
  }
}
