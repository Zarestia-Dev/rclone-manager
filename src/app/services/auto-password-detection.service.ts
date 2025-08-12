import { Injectable, inject } from '@angular/core';
import { listen } from '@tauri-apps/api/event';
import { RclonePasswordService } from './rclone-password.service';
import { MatSnackBar } from '@angular/material/snack-bar';

@Injectable({
  providedIn: 'root',
})
export class AutoPasswordDetectionService {
  private passwordService = inject(RclonePasswordService);
  private snackBar = inject(MatSnackBar);

  constructor() {
    this.setupDetection();
  }

  private async setupDetection(): Promise<void> {
    try {
      // Listen for the specific event we emit from backend
      await listen('rclone_password_required', async (event: any) => {
        const payload = event.payload;
        console.log('🔑 Password required detected:', payload);

        // Show immediate notification
        const snackRef = this.snackBar.open(
          `🔑 ${payload.reason || 'Rclone needs your password'}`,
          'Provide Password',
          {
            duration: 10000,
            panelClass: ['password-required-snackbar'],
          }
        );

        // Handle the action
        snackRef.onAction().subscribe(async () => {
          try {
            const result = await this.passwordService.promptForPassword({
              title: 'Rclone Configuration Password Required',
              description:
                payload.reason || 'Your rclone configuration requires a password to continue.',
              showStoreOption: true,
              isRequired: true,
            });

            if (result) {
              this.snackBar.open('✅ Password provided, retrying operation...', 'Close', {
                duration: 3000,
              });
              // Reset the prompt flag so new prompts can appear
              await this.passwordService.resetPasswordValidator();
            }
          } catch (error) {
            console.error('Error handling password prompt:', error);
            this.snackBar.open('Failed to handle password request', 'Close', { duration: 3000 });
          }
        });

        // Auto-prompt after a short delay if user doesn't click
        setTimeout(async () => {
          if (snackRef) {
            snackRef.dismiss();
            await this.autoPromptPassword(payload.reason);
          }
        }, 5000);
      });

      console.log('✅ Auto password detection service initialized');
    } catch (error) {
      console.error('Failed to setup auto password detection:', error);
    }
  }

  private async autoPromptPassword(reason?: string): Promise<void> {
    try {
      const result = await this.passwordService.promptForPassword({
        title: 'Rclone Password Required',
        description: reason || 'Rclone needs your configuration password to continue.',
        showStoreOption: true,
        isRequired: true,
      });

      if (result) {
        this.snackBar.open('✅ Password provided successfully', 'Close', { duration: 3000 });
      } else {
        this.snackBar
          .open('Password required to continue rclone operations', 'Retry', { duration: 8000 })
          .onAction()
          .subscribe(() => this.autoPromptPassword(reason));
      }
    } catch (error) {
      console.error('Error in auto password prompt:', error);
    }
  }

  /**
   * Manually trigger password detection (useful for testing)
   */
  async triggerManualPasswordPrompt(): Promise<void> {
    try {
      // Call the backend command to trigger the event
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('trigger_password_prompt', {
        reason: 'Manual password request from UI',
      });
    } catch (error) {
      console.error('Failed to trigger manual password prompt:', error);
    }
  }
}
