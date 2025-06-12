import { Component } from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { StateService } from "../../services/state.service";
import { MatButtonModule } from "@angular/material/button";
import { MatTooltipModule } from "@angular/material/tooltip";
import { AppTab } from "../../shared/components/types";

@Component({
  selector: "app-tabs-buttons",
  imports: [MatIconModule, MatButtonModule, MatTooltipModule],
  templateUrl: "./tabs-buttons.component.html",
  styleUrl: "./tabs-buttons.component.scss",
})
export class TabsButtonsComponent {
  currentTab: AppTab = "general";

  constructor(private stateService: StateService) {}
  setTab(tab: AppTab) {
    this.stateService.setTab(tab);
    this.currentTab = tab;
  }

  ngOnInit() {
    this.stateService.currentTab$.subscribe((tab) => {
      this.currentTab = tab;
    });
  }
}
