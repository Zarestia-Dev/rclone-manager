import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { invoke } from "@tauri-apps/api/core";
import { TitlebarComponent } from './components/titlebar/titlebar.component';
import { OnboardingComponent } from './components/onboarding/onboarding.component';
import { HomeComponent } from './home/home.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, TitlebarComponent, OnboardingComponent, HomeComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  greetingMessage = "";

  greet(event: SubmitEvent, name: string): void {
    event.preventDefault();

    invoke<string>("greet", { name }).then((text) => {
      this.greetingMessage = text;
    });
  }
  showOnboarding = true;
  
  
  ngOnInit() {
    // localStorage.setItem('onboardingCompleted', 'false');
    const onboarded = localStorage.getItem('onboardingCompleted');
    this.showOnboarding = onboarded !== 'true';
    
  }
  
  finishOnboarding() {
    console.log(this.showOnboarding);
    localStorage.setItem('onboardingCompleted', 'true');
    this.showOnboarding = false;
  }
}
