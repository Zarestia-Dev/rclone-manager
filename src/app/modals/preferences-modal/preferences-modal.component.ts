import { animate, style, transition, trigger } from "@angular/animations";
import { Component, HostListener } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatTabsModule } from "@angular/material/tabs";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { CommonModule } from "@angular/common";
import { MatInputModule } from "@angular/material/input";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatDialogRef } from "@angular/material/dialog";
import { SettingsService } from "../../services/settings.service";
import { MatSelectModule } from "@angular/material/select";
import { MatTooltipModule } from "@angular/material/tooltip";

@Component({
  selector: "app-preferences-modal",
  imports: [
    MatTabsModule,
    MatSlideToggleModule,
    CommonModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  templateUrl: "./preferences-modal.component.html",
  styleUrl: "./preferences-modal.component.scss",
  animations: [
    trigger("slideAnimation", [
      transition(":enter", [
        style({ opacity: 0, transform: "translateX(100%)" }),
        animate(
          "300ms ease-out",
          style({ opacity: 1, transform: "translateX(0)" })
        ),
      ]),
      transition(":leave", [
        animate(
          "300ms ease-in",
          style({ opacity: 0, transform: "translateX(-100%)" })
        ),
      ]),
    ]),
  ],
})
export class PreferencesModalComponent {
  selectedTabIndex = 0;
  settings: any = {};
  metadata: any = {}; // ✅ Store metadata separately

  tabs = [
    { label: "General", icon: "wrench.svg", key: "general" },
    { label: "Core", icon: "puzzle-piece.svg", key: "core" },
    { label: "Experimental", icon: "flask.svg", key: "experimental" },
  ];

  constructor(
    private dialogRef: MatDialogRef<PreferencesModalComponent>,
    private settingsService: SettingsService
  ) {}

  async ngOnInit() {
    const response = await this.settingsService.loadSettings();
    this.settings = response.settings;
    this.metadata = response.metadata; // ✅ Load metadata separately
    console.log("Loaded settings:", this.settings);
    console.log("Loaded metadata:", this.metadata);
  }

  async updateSetting(category: string, key: string, value: any) {
    console.log(`Updated ${category}.${key}:`, value);
  
    // Convert to number if necessary
    const metadata = this.getMetadata(category, key);
    if (metadata.value_type === "u16" || metadata.value_type === "number") {
      value = Number(value);
    }
  
    this.settingsService.saveSetting(category, key, value);
  }
  

  @HostListener("document:keydown.escape", ["$event"])
  close() {
    this.dialogRef.close();
  }

  selectedTab: string = this.tabs[0].key;

  selectTab(index: number) {
    this.selectedTabIndex = index;
    this.selectedTab = this.tabs[index].key;
  }

  /** ✅ Get metadata for a setting */
  getMetadata(category: string, key: string) {
    return (
      this.metadata?.[`${category}.${key}`] || {
        display_name: key,
        help_text: "",
        value_type: "string",
      }
    );
  }

  getObjectKeys(obj: any): string[] {
    return obj && typeof obj === "object" ? Object.keys(obj) : [];
  }
}
