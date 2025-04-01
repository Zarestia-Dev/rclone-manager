import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import { TitlebarComponent } from './components/titlebar/titlebar.component';
import { OnboardingComponent } from './components/onboarding/onboarding.component';
import { HomeComponent } from './home/home.component';
// import { RightClickDirective } from './directives/right-click.directive';

@Component({
    selector: 'app-root',
    imports: [CommonModule, RouterOutlet, TitlebarComponent, OnboardingComponent, HomeComponent /*, RightClickDirective*/],
    templateUrl: './app.component.html',
    styleUrl: './app.component.scss'
})
export class AppComponent {
  showOnboarding = false;

  finishOnboarding() {
    console.log(this.showOnboarding);
    this.showOnboarding = false;
  }

  // hideMenu() {
  //   const menu = document.getElementById('custom-menu');
  //   if (menu) {
  //     menu.style.display = 'none';
  //   }
  // }

  // onOptionClick(option: string) {
  //   alert(`You clicked: ${option}`);
  //   this.hideMenu();
  // }

  // // Hide menu when clicking anywhere outside
  // @HostListener('document:click')
  // onClickOutside() {
  //   this.hideMenu();
  // }
}
