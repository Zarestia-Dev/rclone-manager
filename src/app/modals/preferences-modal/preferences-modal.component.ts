import { animate, style, transition, trigger } from "@angular/animations";
import { Component, HostListener } from "@angular/core";
import { FormBuilder, FormGroup, FormsModule } from "@angular/forms";
import { MatTabsModule } from "@angular/material/tabs";
import { MatSlideToggleModule } from "@angular/material/slide-toggle";
import { CommonModule } from "@angular/common";
import { MatRadioModule } from "@angular/material/radio";
import { MatInputModule } from "@angular/material/input";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatDialogRef } from "@angular/material/dialog";
import { MatOptionModule } from "@angular/material/core";
import { AppSettings, SettingsService } from "../../services/settings.service";

@Component({
  selector: "app-preferences-modal",
  standalone: true,
  imports: [
    MatTabsModule,
    MatSlideToggleModule,
    CommonModule,
    MatRadioModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    MatOptionModule,
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
  generalForm: FormGroup;
  appearanceForm: FormGroup;
  advancedForm: FormGroup;

  settings: AppSettings = {
    tray_enabled: true,
    start_minimized: false,
    auto_refresh: true,
    notifications: true,
    rclone_api_port: 5572,
    default_mount_type: 'native',
    debug_logging: false,
    bandwidth_limit: ''
  };
  selectTab(index: number) {
    this.selectedTabIndex = index;
  }

  tabs = [
    { label: "General", icon: "wrench.svg" },
    { label: "Core", icon: "puzzle-piece.svg" },
    { label: "Experiments", icon: "flask.svg" },
  ];

  constructor(
    private dialogRef: MatDialogRef<PreferencesModalComponent>,
    private fb: FormBuilder,
    private settingsService: SettingsService
  ) {
    this.generalForm = this.fb.group({
      enableNotifications: [true],
      language: ["en"],
    });

    this.appearanceForm = this.fb.group({
      darkMode: [false],
      themeColor: ["blue"],
    });

    this.advancedForm = this.fb.group({
      enableLogging: [false],
      performanceMode: [false],
    });
  }


  async ngOnInit() {
    this.settings = await this.settingsService.loadSettings();
  }

  async save() {
    await this.settingsService.saveSettings(this.settings);
  }

  @HostListener("document:keydown.escape", ["$event"])
  close() {
    this.save()
    this.dialogRef.close();
  }

  onTabChange(index: number) {
    this.selectedTabIndex = index;
  }
}
