import {
  animate,
  state,
  style,
  transition,
  trigger,
} from "@angular/animations";
import { CommonModule } from "@angular/common";
import { Component, EventEmitter, Output, OnInit } from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatDividerModule } from "@angular/material/divider";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { invoke } from "@tauri-apps/api/core";
import { MatRadioModule } from "@angular/material/radio";
import { RcloneService } from "../../services/rclone.service";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";

@Component({
  selector: "app-onboarding",
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatDividerModule,
    MatFormFieldModule,
    FormsModule,
    MatInputModule,
    MatRadioModule,
    MatButtonModule,
    MatIconModule
  ],
  animations: [
    trigger("slideAnimation", [
      state("void", style({ opacity: 0, transform: "translateX(100%)" })),
      state("forward", style({ opacity: 1, transform: "translateX(0)" })),
      state("backward", style({ opacity: 1, transform: "translateX(0)" })),
      transition("void => forward", [animate("300ms ease-out")]),
      transition("forward => void", [
        animate(
          "300ms ease-in",
          style({ opacity: 0, transform: "translateX(-100%)" })
        ),
      ]),
      transition("void => backward", [
        animate(
          "300ms ease-out",
          style({ opacity: 0, transform: "translateX(-100%)" })
        ),
      ]),
      transition("backward => void", [
        animate(
          "300ms ease-in",
          style({ opacity: 0, transform: "translateX(100%)" })
        ),
      ]),
    ]),
    trigger("slideInOut", [
      transition(":enter", [
        style({ height: "0px", opacity: 0 }),
        animate("200ms ease-out", style({ height: "*", opacity: 1 })),
      ]),
      transition(":leave", [
        animate("200ms ease-in", style({ height: "0px", opacity: 0 })),
      ]),
    ]),
  ],
  templateUrl: "./onboarding.component.html",
  styleUrls: ["./onboarding.component.scss"],
})
export class OnboardingComponent implements OnInit {
  installLocation: "default" | "custom" = "default";
  customPath: string = "";
  mountPluginRequired = false;
  downloadingPlugin = false;
  currentCardIndex = 0;
  rcloneInstalled = false;
  installing = false;

  @Output() completed = new EventEmitter<void>();
  animationState: "forward" | "backward" = "forward";

  // Base cards that are always shown
  private baseCards = [
    {
      image: "../assets/rclone.svg",
      title: "Welcome to RClone Manager",
      content:
        "RClone Manager helps you manage your remotes easily. Let's get started!",
    },
    {
      image: "../assets/rclone.svg",
      title: "Features",
      content: "Sync, mount, and manage cloud storage effortlessly.",
    },
    {
      image: "../assets/rclone.svg",
      title: "System Check",
      content: "We will check if RClone and required plugins are installed.",
    },
  ];

  // Dynamic cards that will be added based on conditions
  cards = [...this.baseCards];

  constructor(private rcloneService: RcloneService) {}

  async ngOnInit(): Promise<void> {
    await this.checkRclone();
    await this.checkMountPlugin();
  }

  async checkRclone(): Promise<void> {
    try {
      this.rcloneInstalled = await invoke<boolean>("check_rclone_installed");
      if (!this.rcloneInstalled) {
        this.cards.splice(3, 0, {
          image: "../assets/rclone.svg",
          title: "Install RClone",
          content: "RClone is not installed. Click below to install it.",
        });
      }
    } catch (error) {
      console.error("Error checking rclone:", error);
      this.rcloneInstalled = false;
    }
  }

  async checkMountPlugin(): Promise<void> {
    try {
      this.mountPluginRequired = await invoke<boolean>("check_mount_plugin");
      if (this.mountPluginRequired) {
        // Add after install rclone card if it exists, otherwise at position 3
        const insertPosition = this.cards.length > 3 ? 4 : 3;
        this.cards.splice(insertPosition, 0, {
          image: "../assets/rclone.svg",
          title: "Install Mount Plugin",
          content: "The mount plugin is missing. Click below to install it.",
        });
      }
    } catch (error) {
      console.error("Error checking mount plugin:", error);
      this.mountPluginRequired = false;
    }

    // Always add setup complete as the last card
    if (!this.cards.some((card) => card.title === "Setup Complete")) {
      this.cards.push({
        image: "../assets/rclone.svg",
        title: "Setup Complete",
        content: "You're all set! Start using RClone Manager.",
      });
    }
  }

  async selectCustomPath(): Promise<void> {
    const path = await this.rcloneService.selectFolder(false);
    if (path) {
      this.customPath = path;
    }
  }

  nextCard(): void {
    this.animationState = "forward";
    if (this.currentCardIndex < this.cards.length - 1) {
      this.currentCardIndex++;
    }
  }

  previousCard(): void {
    this.animationState = "backward";
    if (this.currentCardIndex > 0) {
      this.currentCardIndex--;
    }
  }

  async installMountPlugin(): Promise<void> {
    this.downloadingPlugin = true;
    try {
      const filePath = await invoke<string>("install_mount_plugin");
      console.log("Downloaded plugin at:", filePath);
      this.mountPluginRequired = false;
      // Optionally move to next card after installation
      this.nextCard();
    } catch (error) {
      console.error("Plugin installation failed:", error);
    } finally {
      this.downloadingPlugin = false;
    }
  }

  async installRclone(): Promise<void> {
    this.installing = true;
    try {
      const installPath =
        this.installLocation === "default" ? null : this.customPath;
      const result = await invoke<string>("provision_rclone", {
        path: installPath,
      });
      console.log("Installation result:", result);
      this.rcloneInstalled = true;
      // Move to next card after installation
      this.nextCard();
    } catch (error) {
      console.error(`Installation failed: ${error}`);
    } finally {
      this.installing = false;
    }
  }

  // Add these methods to your component class
  shouldShowInstallRcloneButton(): boolean {
    return (
      this.currentCardIndex ===
        this.cards.findIndex((c) => c.title === "Install RClone") &&
      !this.rcloneInstalled
    );
  }

  shouldShowInstallPluginButton(): boolean {
    return (
      this.currentCardIndex ===
        this.cards.findIndex((c) => c.title === "Install Mount Plugin") &&
      this.mountPluginRequired
    );
  }

  shouldShowActionButton(): boolean {
    return (
      this.shouldShowInstallRcloneButton() ||
      this.shouldShowInstallPluginButton() ||
      this.cards[this.currentCardIndex].title === "Setup Complete"
    );
  }

  completeOnboarding(): void {
    this.completed.emit();
  }
}
