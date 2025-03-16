import { animate, state, style, transition, trigger } from '@angular/animations';
import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Output } from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { invoke } from '@tauri-apps/api/core';

@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [CommonModule, MatCardModule, MatDividerModule],
  animations: [
    trigger('slideAnimation', [
      state('void', style({ opacity: 0, transform: 'translateX(100%)' })),
      state('forward', style({ opacity: 1, transform: 'translateX(0)' })),
      state('backward', style({ opacity: 1, transform: 'translateX(0)' })),
      transition('void => forward', [animate('300ms ease-out')]),
      transition('forward => void', [animate('300ms ease-in', style({ opacity: 0, transform: 'translateX(-100%)' }))]),
      transition('void => backward', [animate('300ms ease-out', style({ opacity: 0, transform: 'translateX(-100%)' }))]),
      transition('backward => void', [animate('300ms ease-in', style({ opacity: 0, transform: 'translateX(100%)' }))]),
    ]),
  ],
  templateUrl: './onboarding.component.html',
  styleUrl: './onboarding.component.scss'
})
export class OnboardingComponent {
  currentCardIndex = 0;
  rcloneInstalled = false;
  installing = false;
  @Output() completed = new EventEmitter<void>();

  cards = [
    { image: "../assets/rclone.svg", title: 'Welcome to RClone Manager', content: 'RClone Manager is a GUI app for rclone app the manage your remotes easily.' },
    { image: "../assets/rclone.svg", title: 'Features', content: 'Discover amazing features.' },
    { image: "../assets/rclone.svg", title: 'Setup', content: 'Get started in a few steps.' },
    { image: "../assets/rclone.svg", title: 'Tips', content: 'Here are some tips to help you.' },
    { image: "../assets/rclone.svg", title: 'Ready', content: 'You’re all set! Start exploring.' },
  ];

  animationState: 'forward' | 'backward' = 'forward';

  nextCard() {
    this.animationState = 'forward';
    if (this.currentCardIndex < this.cards.length - 1) {
      this.currentCardIndex++;
    }
  }

  ngOnInit(): void {
    this.checkRclone();
  }

  async checkRclone() {
    this.rcloneInstalled = await invoke<boolean>("check_rclone_installed");
    if (!this.rcloneInstalled) {
      this.cards.push({ image: "../assets/rclone.svg", title: 'Install Rclone', content: 'Rclone is not installed. Please install it to continue.' });
    }
  }

  async installRclone() {
    this.installing = true;
    try {
      const result = await invoke<string>("provision_rclone");
      alert(result);
      this.rcloneInstalled = true;
    } catch (error) {
      alert(`Installation failed: ${error}`);
    } finally {
      this.installing = false;
    }
  }

  previousCard() {
    this.animationState = 'backward';
    if (this.currentCardIndex > 0) {
      this.currentCardIndex--;
    }
  }


  completeOnboarding() {
    this.completed.emit();
  }
}