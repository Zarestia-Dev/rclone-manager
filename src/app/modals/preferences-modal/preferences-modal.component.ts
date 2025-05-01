import { animate, style, transition, trigger } from "@angular/animations";
import { Component, HostListener, OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { CommonModule } from "@angular/common";
import { MatInputModule } from "@angular/material/input";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatDialogRef } from "@angular/material/dialog";
import { SettingsService } from "../../services/settings.service";
import { MatSelectModule } from "@angular/material/select";
import { MatTooltipModule } from "@angular/material/tooltip";
import { MatIconModule } from "@angular/material/icon";
import { MatButtonModule } from "@angular/material/button";

@Component({
  selector: "app-preferences-modal",
  standalone: true,
  imports: [
    MatSlideToggleModule,
    CommonModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    MatSelectModule,
    MatTooltipModule,
    MatIconModule,
    MatButtonModule
  ],
  templateUrl: "./preferences-modal.component.html",
  styleUrls: ["./preferences-modal.component.scss"],
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
export class PreferencesModalComponent implements OnInit {
  selectedTabIndex = 0;
  settings: any = {};
  metadata: any = {};
  bottomTabs = false;

  tabs = [
    { label: "General", icon: "wrench", key: "general" },
    { label: "Core", icon: "puzzle-piece", key: "core" },
    { label: "Experimental", icon: "flask", key: "experimental" },
  ];

  constructor(
    private dialogRef: MatDialogRef<PreferencesModalComponent>,
    private settingsService: SettingsService,
  ) {}

  ngOnInit() {
    this.onResize();
    this.loadSettings();
  }

  @HostListener('window:resize')
  onResize() {
    this.bottomTabs = window.innerWidth < 540;
  }

  async loadSettings() {
    const response = await this.settingsService.loadSettings();
    this.settings = response.settings;
    this.metadata = response.metadata;
  }

  async updateSetting(category: string, key: string, value: any) {
    const metadata = this.getMetadata(category, key);
        
    // ✅ Validate numeric inputs
    if (metadata.value_type === "u16" || metadata.value_type === "number") {
      if (isNaN(value) || value === null || value === undefined || value < 0) {
        console.warn(`🚫 Invalid number entered for ${category}.${key}:`, value);
        value = this.settings[category][key][value]; // Reset to previous value
        return; // Stop saving
      }
      value = Number(value);
    }
  
    console.log(`🔄 Saving setting: ${category}.${key} =`, value);
    
    // ✅ Save only if valid
    await this.settingsService.saveSetting(category, key, value);
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

  async resetSettings() {
      await this.settingsService.resetSettings();
  }
}
