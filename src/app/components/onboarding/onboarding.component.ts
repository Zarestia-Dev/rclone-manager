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
import { MatTooltipModule } from "@angular/material/tooltip";
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
    MatTooltipModule,
  ],
  animations: [
    // Onboarding entrance animation
    trigger("onboardingEntrance", [
      transition(":enter", [
        style({ opacity: 0, transform: "scale(0.95)" }),
        animate(
          "600ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          style({ opacity: 1, transform: "scale(1)" })
        ),
      ]),
      transition(":leave", [
        animate(
          "400ms cubic-bezier(0.55, 0.06, 0.68, 0.19)",
          style({ opacity: 0, transform: "scale(0.95)" })
        ),
      ]),
    ]),
    // Content fade-in after initialization
    trigger("contentFadeIn", [
      transition(":enter", [
        style({ opacity: 0, transform: "translateY(20px)" }),
        animate(
          "500ms 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          style({ opacity: 1, transform: "translateY(0)" })
        ),
      ]),
    ]),
    // Loading spinner
    trigger("loadingSpinner", [
      transition(":enter", [
        style({ opacity: 0, transform: "scale(0.8)" }),
        animate(
          "300ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          style({ opacity: 1, transform: "scale(1)" })
        ),
      ]),
      transition(":leave", [
        animate(
          "200ms cubic-bezier(0.55, 0.06, 0.68, 0.19)",
          style({ opacity: 0, transform: "scale(0.8)" })
        ),
      ]),
    ]),
    trigger("slideInOut", [
      transition(":enter", [
        style({ height: "0px", opacity: 0, transform: "translateY(-10px)" }),
        animate("300ms cubic-bezier(0.25, 0.46, 0.45, 0.94)", 
                style({ height: "*", opacity: 1, transform: "translateY(0)" })),
      ]),
      transition(":leave", [
        animate("200ms cubic-bezier(0.55, 0.06, 0.68, 0.19)", 
                style({ height: "0px", opacity: 0, transform: "translateY(-10px)" })),
      ]),
    ]),
  ],
  templateUrl: "./onboarding.component.html",
  styleUrls: ["./onboarding.component.scss"],
})
export class OnboardingComponent implements OnInit {
  @Output() completed = new EventEmitter<void>();

  installLocation: "default" | "custom" = "default";
  customPath: string = "";
  mountPluginInstalled = false;
  downloadingPlugin = false;
  currentCardIndex = 0;
  rcloneInstalled = false;
  installing = false;
  
  // Add initialization state
  isInitializing = true;
  initializationComplete = false;


  // Base cards that are always shown
  private baseCards = [
    {
      image: "../assets/rclone.svg",
      title: "Welcome to RClone Manager",
      content:
        "Your modern cloud storage management solution. RClone Manager provides an intuitive interface to sync, mount, and manage all your cloud remotes effortlessly.",
    },
    {
      image: "../assets/rclone.svg",
      title: "Powerful Features",
      content: "Seamlessly sync files, mount cloud storage as local drives, manage multiple remotes, and monitor transfer operations - all from one beautiful interface.",
    },
  ];

  // Dynamic cards that will be added based on conditions
  cards = [...this.baseCards];

  constructor(private rcloneService: RcloneService) {}

  async ngOnInit(): Promise<void> {
    console.log("OnboardingComponent: ngOnInit started");
    
    // Add a small delay for smooth entrance
    setTimeout(async () => {
      console.log("OnboardingComponent: Starting system checks");
      try {
        await this.checkRclone();
        console.log("OnboardingComponent: checkRclone completed");
        
        await this.checkMountPlugin();
        console.log("OnboardingComponent: checkMountPlugin completed");
        
        // Mark initialization as complete
        this.isInitializing = false;
        
        // Add another small delay for the initialization complete animation
        setTimeout(() => {
          this.initializationComplete = true;
          console.log("OnboardingComponent: Initialization complete");
        }, 300);
      } catch (error) {
        console.error("OnboardingComponent: System checks failed", error);
        this.isInitializing = false;
        this.initializationComplete = true;
      }
    }, 500); // Initial delay for app to settle
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
          content: "RClone is required for cloud storage operations. Choose your preferred installation location and we'll handle the setup automatically.",
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
          content: "The mount plugin enables you to mount cloud storage as local drives. This optional component enhances your RClone experience.",
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
        title: "Ready to Go!",
        content: "Everything is set up and ready to use. RClone Manager will help you manage your cloud storage with ease. Click 'Get Started' to begin your journey.",
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
    setTimeout(() => {
      if (this.currentCardIndex < this.cards.length - 1) {
        this.currentCardIndex++;
      }
    });
  }

  previousCard(): void {
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
      this.cards[this.currentCardIndex].title === "Ready to Go!"
    );
  }

  // Add validation for custom path installation
  canInstallRclone(): boolean {
    if (this.installing) {
      return false;
    }
    
    // If default installation is selected, always allow
    if (this.installLocation === "default") {
      return true;
    }
    
    // If custom installation is selected, require a path to be selected
    if (this.installLocation === "custom") {
      return this.customPath.trim().length > 0;
    }
    
    return false;
  }

  // Get dynamic button text based on validation state
  getInstallButtonText(): string {
    if (this.installing) {
      return "Installing...";
    }
    
    if (this.installLocation === "custom" && this.customPath.trim().length === 0) {
      return "Select Path First";
    }
    
    return "Install RClone";
  }

  completeOnboarding(): void {
    this.completed.emit();
  }
}