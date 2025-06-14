import { animate, style, transition, trigger } from "@angular/animations";
import { CommonModule } from "@angular/common";
import {
  Component,
  EventEmitter,
  Output,
  OnInit,
  HostListener,
} from "@angular/core";
import { MatCardModule } from "@angular/material/card";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import { invoke } from "@tauri-apps/api/core";
import { MatRadioModule } from "@angular/material/radio";
import { RcloneService } from "../../services/rclone.service";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { listen } from "@tauri-apps/api/event";

@Component({
  selector: "app-onboarding",
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatFormFieldModule,
    FormsModule,
    MatInputModule,
    MatRadioModule,
    MatButtonModule,
    MatIconModule,
  ],
  animations: [
    trigger("slideAnimation", [
      // Slide in from right (next)
      transition("void => forward", [
        style({ transform: "translateX(100%)", opacity: 0 }),
        animate(
          "300ms ease-out",
          style({ transform: "translateX(0)", opacity: 1 })
        ),
      ]),

      // Slide out to left (next)
      transition("forward => void", [
        animate(
          "300ms ease-in",
          style({ transform: "translateX(-100%)", opacity: 0 })
        ),
      ]),

      // Slide in from left (back)
      transition("void => backward", [
        style({ transform: "translateX(-100%)", opacity: 0 }),
        animate(
          "300ms ease-out",
          style({ transform: "translateX(0)", opacity: 1 })
        ),
      ]),

      // Slide out to right (back)
      transition("backward => void", [
        animate(
          "300ms ease-in",
          style({ transform: "translateX(100%)", opacity: 0 })
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
  @Output() completed = new EventEmitter<void>();

  animationState: "forward" | "backward" = "forward";
  installLocation: "default" | "custom" = "default";
  customPath: string = "";
  mountPluginInstalled = false;
  downloadingPlugin = false;
  currentCardIndex = 0;
  rcloneInstalled = false;
  installing = false;


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
  ];

  // Dynamic cards that will be added based on conditions
  cards = [...this.baseCards];

  constructor(private rcloneService: RcloneService) {}

  async ngOnInit(): Promise<void> {
    await this.checkRclone();
    await this.checkMountPlugin();
  }

  @HostListener("document:keydown", ["$event"])
  handleKeyboardEvent(event: KeyboardEvent): void {
    if (event.key === "ArrowRight" || event.key === "Enter") {
      if (this.currentCardIndex < this.cards.length - 1) {
        this.nextCard();
      } else {
        this.completeOnboarding();
      }
    } else if (event.key === "ArrowLeft") {
      if (this.currentCardIndex > 0) {
        this.previousCard();
      }
    }
  }

  async checkRclone(): Promise<void> {
    try {
      this.rcloneInstalled = await invoke<boolean>("is_rclone_available");
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
      this.mountPluginInstalled = await invoke<boolean>("check_mount_plugin_installed");
      if (!this.mountPluginInstalled) {
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
      this.mountPluginInstalled = false;
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
    setTimeout(() => {
      if (this.currentCardIndex < this.cards.length - 1) {
        this.currentCardIndex++;
      }
    });
  }

  previousCard(): void {
    this.animationState = "backward";
    setTimeout(() => {
      if (this.currentCardIndex > 0) {
        this.currentCardIndex--;
      }
    });
  }

  async installMountPlugin(): Promise<void> {
    this.downloadingPlugin = true;
    try {
      const filePath = await invoke<string>("install_mount_plugin");
      console.log("Downloaded plugin at:", filePath);
      listen("mount_plugin_installed", () => {
        this.mountPluginInstalled = true;
        // Optionally move to next card after installation
        this.nextCard();
      });
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
      console.error("RClone installation failed:", error);
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
      this.mountPluginInstalled === false
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