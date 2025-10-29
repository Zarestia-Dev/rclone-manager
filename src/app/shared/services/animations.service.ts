import { Injectable } from '@angular/core';
import {
  AnimationTriggerMetadata,
  animate,
  style,
  transition,
  trigger,
  state,
  query,
  group,
  keyframes, // <-- Import keyframes
} from '@angular/animations';

@Injectable({
  providedIn: 'root',
})
export class AnimationsService {
  /**
   * Fade animations
   */
  static fadeIn(duration = '300ms', delay = '0ms'): AnimationTriggerMetadata {
    return trigger('fadeIn', [
      transition(':enter', [
        animate(
          `${duration} ${delay} ease-in-out`,
          keyframes([style({ opacity: 0, offset: 0 }), style({ opacity: 1, offset: 1 })])
        ),
      ]),
    ]);
  }

  static fadeOut(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('fadeOut', [
      transition(':leave', [
        animate(
          `${duration} ease-in-out`,
          keyframes([style({ opacity: 1, offset: 0 }), style({ opacity: 0, offset: 1 })])
        ),
      ]),
    ]);
  }

  static fadeInOut(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('fadeInOut', [
      transition(':enter', [
        animate(
          `${duration} ease-in-out`,
          keyframes([style({ opacity: 0, offset: 0 }), style({ opacity: 1, offset: 1 })])
        ),
      ]),
      transition(':leave', [
        animate(
          `${duration} ease-in-out`,
          keyframes([style({ opacity: 1, offset: 0 }), style({ opacity: 0, offset: 1 })])
        ),
      ]),
    ]);
  }

  /**
   * Scale animations
   */
  static scaleIn(duration = '300ms', delay = '0ms'): AnimationTriggerMetadata {
    return trigger('scaleIn', [
      transition(':enter', [
        animate(
          `${duration} ${delay} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ opacity: 0, transform: 'scale(0.8)', offset: 0 }),
            style({ opacity: 1, transform: 'scale(1)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  static scaleOut(duration = '200ms'): AnimationTriggerMetadata {
    return trigger('scaleOut', [
      transition(':leave', [
        animate(
          `${duration} cubic-bezier(0.55, 0.06, 0.68, 0.19)`,
          keyframes([
            style({ opacity: 1, transform: 'scale(1)', offset: 0 }),
            style({ opacity: 0, transform: 'scale(0.8)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  static scaleInOut(enterDuration = '300ms', leaveDuration = '200ms'): AnimationTriggerMetadata {
    return trigger('scaleInOut', [
      transition(':enter', [
        animate(
          `${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ opacity: 0, transform: 'scale(0.8)', offset: 0 }),
            style({ opacity: 1, transform: 'scale(1)', offset: 1 }),
          ])
        ),
      ]),
      transition(':leave', [
        animate(
          `${leaveDuration} cubic-bezier(0.55, 0.06, 0.68, 0.19)`,
          keyframes([
            style({ opacity: 1, transform: 'scale(1)', offset: 0 }),
            style({ opacity: 0, transform: 'scale(0.8)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  /**
   * Slide animations
   */
  static slideInFromTop(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('slideInFromTop', [
      transition(':enter', [
        animate(
          `${duration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ opacity: 0, transform: 'translateY(-20px)', offset: 0 }),
            style({ opacity: 1, transform: 'translateY(0)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  /**
   * Slide from bottom with both enter and leave transitions.
   * Useful for message bars that should animate in and out.
   */
  static slideInFromBottom(
    enterDuration = '300ms',
    leaveDuration = '200ms'
  ): AnimationTriggerMetadata {
    return trigger('slideInFromBottom', [
      transition(':enter', [
        animate(
          `${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ opacity: 0, transform: 'translateY(20px)', offset: 0 }),
            style({ opacity: 1, transform: 'translateY(0)', offset: 1 }),
          ])
        ),
      ]),
      transition(':leave', [
        animate(
          `${leaveDuration} cubic-bezier(0.55, 0.06, 0.68, 0.19)`,
          keyframes([
            style({ opacity: 1, transform: 'translateY(0)', offset: 0 }),
            style({ opacity: 0, transform: 'translateY(20px)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  static slideInFromLeft(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('slideInFromLeft', [
      transition(':enter', [
        animate(
          `${duration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ opacity: 0, transform: 'translateX(-20px)', offset: 0 }),
            style({ opacity: 1, transform: 'translateX(0)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  static slideInFromRight(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('slideInFromRight', [
      transition(':enter', [
        animate(
          `${duration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ opacity: 0, transform: 'translateX(20px)', offset: 0 }),
            style({ opacity: 1, transform: 'translateX(0)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  static slideOutToRight(duration = '200ms'): AnimationTriggerMetadata {
    return trigger('slideOutToRight', [
      transition(':leave', [
        animate(
          `${duration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ transform: 'translateX(0%)', offset: 0 }),
            style({ transform: 'translateX(100%)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  static slideInOut(enterDuration = '300ms', leaveDuration = '200ms'): AnimationTriggerMetadata {
    return trigger('slideInOut', [
      transition(':enter', [
        animate(
          `${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ height: '0px', opacity: 0, transform: 'translateY(-10px)', offset: 0 }),
            style({ height: '*', opacity: 1, transform: 'translateY(0)', offset: 1 }),
          ])
        ),
      ]),
      transition(':leave', [
        animate(
          `${leaveDuration} cubic-bezier(0.55, 0.06, 0.68, 0.19)`,
          keyframes([
            style({ height: '*', opacity: 1, transform: 'translateY(0)', offset: 0 }),
            style({ height: '0px', opacity: 0, transform: 'translateY(-10px)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  /**
   * Slide toggle animations (for collapsible content)
   * NOTE: This function already uses the correct, modern syntax and does not need to be changed.
   */
  static slideToggle(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('slideToggle', [
      state('hidden', style({ height: '0px', opacity: 0, padding: 0, overflow: 'hidden' })),
      state('visible', style({ height: '*', opacity: 1, padding: '*', overflow: 'hidden' })),
      transition('hidden <=> visible', animate(`${duration} ease-in-out`)),
    ]);
  }

  /**
   * Overlay animations
   */
  static slideOverlay(enterDuration = '200ms', leaveDuration = '200ms'): AnimationTriggerMetadata {
    return trigger('slideOverlay', [
      transition(':enter', [
        animate(
          `${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ transform: 'translateX(100%)', offset: 0 }),
            style({ transform: 'translateX(0%)', offset: 1 }),
          ])
        ),
      ]),
      transition(':leave', [
        animate(
          `${leaveDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ transform: 'translateX(0%)', offset: 0 }),
            style({ transform: 'translateX(100%)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  /**
   * Complex entrance animations
   */
  static onboardingEntrance(
    enterDuration = '600ms',
    leaveDuration = '400ms'
  ): AnimationTriggerMetadata {
    return trigger('onboardingEntrance', [
      transition(':enter', [
        animate(
          `${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ opacity: 0, transform: 'scale(0.95)', offset: 0 }),
            style({ opacity: 1, transform: 'scale(1)', offset: 1 }),
          ])
        ),
      ]),
      transition(':leave', [
        animate(
          `${leaveDuration} cubic-bezier(0.55, 0.06, 0.68, 0.19)`,
          keyframes([
            style({ opacity: 1, transform: 'scale(1)', offset: 0 }),
            style({ opacity: 0, transform: 'scale(0.95)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  static contentFadeIn(duration = '500ms', delay = '200ms'): AnimationTriggerMetadata {
    return trigger('contentFadeIn', [
      transition(':enter', [
        animate(
          `${duration} ${delay} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ opacity: 0, transform: 'translateY(20px)', offset: 0 }),
            style({ opacity: 1, transform: 'translateY(0)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  /**
   * Loading spinner animation
   */
  static loadingSpinner(
    enterDuration = '300ms',
    leaveDuration = '200ms'
  ): AnimationTriggerMetadata {
    return trigger('loadingSpinner', [
      transition(':enter', [
        animate(
          `${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
          keyframes([
            style({ opacity: 0, transform: 'scale(0.8)', offset: 0 }),
            style({ opacity: 1, transform: 'scale(1)', offset: 1 }),
          ])
        ),
      ]),
      transition(':leave', [
        animate(
          `${leaveDuration} cubic-bezier(0.55, 0.06, 0.68, 0.19)`,
          keyframes([
            style({ opacity: 1, transform: 'scale(1)', offset: 0 }),
            style({ opacity: 0, transform: 'scale(0.8)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  /**
   * Complex slide animation for multi-step components
   * NOTE: This function uses group() and query() and is already correct.
   */
  static slideAnimation(
    enterDuration = '300ms',
    leaveDuration = '400ms'
  ): AnimationTriggerMetadata {
    return trigger('slideAnimation', [
      transition('* => *', [
        query(':leave', [style({ position: 'absolute', width: '100%' })], {
          optional: true,
        }),
        group([
          query(
            ':enter',
            [
              style({ transform: 'translateX(-100%)', opacity: 0 }),
              animate(
                `${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
                style({ transform: 'translateX(0)', opacity: 1 })
              ),
            ],
            { optional: true }
          ),
          query(
            ':leave',
            [
              style({ transform: 'translateX(0)', opacity: 1 }),
              animate(
                `${leaveDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
                style({ transform: 'translateX(-100%)', opacity: 0 })
              ),
            ],
            { optional: true }
          ),
        ]),
      ]),
    ]);
  }

  /**
   * Enhanced fade in/out with slight vertical movement
   */
  static fadeInOutWithMove(
    enterDuration = '300ms',
    leaveDuration = '200ms'
  ): AnimationTriggerMetadata {
    return trigger('fadeInOut', [
      transition(':enter', [
        animate(
          `${enterDuration} ease-out`,
          keyframes([
            style({ opacity: 0, transform: 'translateY(10px)', offset: 0 }),
            style({ opacity: 1, transform: 'translateY(0)', offset: 1 }),
          ])
        ),
      ]),
      transition(':leave', [
        animate(
          `${leaveDuration} ease-in`,
          keyframes([
            style({ opacity: 1, transform: 'translateY(0)', offset: 0 }),
            style({ opacity: 0, transform: 'translateY(-10px)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  static labelSlideIn(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('labelSlideIn', [
      transition(':enter', [
        animate(
          `${duration} cubic-bezier(0.34, 1.56, 0.64, 1)`,
          keyframes([
            style({ opacity: 0, transform: 'translateX(-40px)', offset: 0 }),
            style({ opacity: 1, transform: 'translateX(0)', offset: 1 }),
          ])
        ),
      ]),
    ]);
  }

  /**
   * Utility method to get multiple animations at once
   */
  static getAnimations(animationNames: string[]): AnimationTriggerMetadata[] {
    const animations: AnimationTriggerMetadata[] = [];

    animationNames.forEach(name => {
      switch (name) {
        case 'fadeIn':
          animations.push(this.fadeIn());
          break;
        case 'fadeOut':
          animations.push(this.fadeOut());
          break;
        case 'fadeInOut':
          animations.push(this.fadeInOut());
          break;
        case 'scaleIn':
          animations.push(this.scaleIn());
          break;
        case 'scaleOut':
          animations.push(this.scaleOut());
          break;
        case 'scaleInOut':
          animations.push(this.scaleInOut());
          break;
        case 'slideInFromTop':
          animations.push(this.slideInFromTop());
          break;
        case 'slideInFromBottom':
          animations.push(this.slideInFromBottom());
          break;
        case 'slideInFromLeft':
          animations.push(this.slideInFromLeft());
          break;
        case 'slideInFromRight':
          animations.push(this.slideInFromRight());
          break;
        case 'slideOutToRight':
          animations.push(this.slideOutToRight());
          break;
        case 'slideInOut':
          animations.push(this.slideInOut());
          break;
        case 'slideToggle':
          animations.push(this.slideToggle());
          break;
        case 'slideOverlay':
          animations.push(this.slideOverlay());
          break;
        case 'onboardingEntrance':
          animations.push(this.onboardingEntrance());
          break;
        case 'contentFadeIn':
          animations.push(this.contentFadeIn());
          break;
        case 'loadingSpinner':
          animations.push(this.loadingSpinner());
          break;
        case 'slideAnimation':
          animations.push(this.slideAnimation());
          break;
        case 'fadeInOutWithMove':
          animations.push(this.fadeInOutWithMove());
          break;
        case 'labelSlideIn':
          animations.push(this.labelSlideIn());
          break;
      }
    });

    return animations;
  }
}
