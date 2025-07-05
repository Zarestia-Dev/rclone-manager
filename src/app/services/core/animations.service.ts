import { Injectable } from '@angular/core';
import { AnimationTriggerMetadata, animate, style, transition, trigger, state, query, group } from '@angular/animations';

@Injectable({
  providedIn: 'root'
})
export class AnimationsService {
  
  /**
   * Fade animations
   */
  static fadeIn(duration = '300ms', delay = '0ms'): AnimationTriggerMetadata {
    return trigger('fadeIn', [
      transition(':enter', [
        style({ opacity: 0 }),
        animate(`${duration} ${delay} ease-in-out`, style({ opacity: 1 }))
      ])
    ]);
  }

  static fadeOut(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('fadeOut', [
      transition(':leave', [
        animate(`${duration} ease-in-out`, style({ opacity: 0 }))
      ])
    ]);
  }

  static fadeInOut(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('fadeInOut', [
      transition(':enter', [
        style({ opacity: 0 }),
        animate(`${duration} ease-in-out`, style({ opacity: 1 }))
      ]),
      transition(':leave', [
        animate(`${duration} ease-in-out`, style({ opacity: 0 }))
      ])
    ]);
  }

  /**
   * Scale animations
   */
  static scaleIn(duration = '300ms', delay = '0ms'): AnimationTriggerMetadata {
    return trigger('scaleIn', [
      transition(':enter', [
        style({ opacity: 0, transform: 'scale(0.8)' }),
        animate(`${duration} ${delay} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ opacity: 1, transform: 'scale(1)' }))
      ])
    ]);
  }

  static scaleOut(duration = '200ms'): AnimationTriggerMetadata {
    return trigger('scaleOut', [
      transition(':leave', [
        animate(`${duration} cubic-bezier(0.55, 0.06, 0.68, 0.19)`, 
                style({ opacity: 0, transform: 'scale(0.8)' }))
      ])
    ]);
  }

  static scaleInOut(
    enterDuration = '300ms', 
    leaveDuration = '200ms'
  ): AnimationTriggerMetadata {
    return trigger('scaleInOut', [
      transition(':enter', [
        style({ opacity: 0, transform: 'scale(0.8)' }),
        animate(`${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ opacity: 1, transform: 'scale(1)' }))
      ]),
      transition(':leave', [
        animate(`${leaveDuration} cubic-bezier(0.55, 0.06, 0.68, 0.19)`, 
                style({ opacity: 0, transform: 'scale(0.8)' }))
      ])
    ]);
  }

  /**
   * Slide animations
   */
  static slideInFromTop(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('slideInFromTop', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(-20px)' }),
        animate(`${duration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ opacity: 1, transform: 'translateY(0)' }))
      ])
    ]);
  }

  static slideInFromBottom(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('slideInFromBottom', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(20px)' }),
        animate(`${duration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ opacity: 1, transform: 'translateY(0)' }))
      ])
    ]);
  }

  static slideInFromLeft(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('slideInFromLeft', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateX(-20px)' }),
        animate(`${duration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ opacity: 1, transform: 'translateX(0)' }))
      ])
    ]);
  }

  static slideInFromRight(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('slideInFromRight', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateX(20px)' }),
        animate(`${duration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ opacity: 1, transform: 'translateX(0)' }))
      ])
    ]);
  }

  static slideOutToRight(duration = '200ms'): AnimationTriggerMetadata {
    return trigger('slideOutToRight', [
      transition(':leave', [
        animate(`${duration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ transform: 'translateX(100%)' }))
      ])
    ]);
  }

  static slideInOut(
    enterDuration = '300ms', 
    leaveDuration = '200ms'
  ): AnimationTriggerMetadata {
    return trigger('slideInOut', [
      transition(':enter', [
        style({ height: '0px', opacity: 0, transform: 'translateY(-10px)' }),
        animate(`${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ height: '*', opacity: 1, transform: 'translateY(0)' }))
      ]),
      transition(':leave', [
        animate(`${leaveDuration} cubic-bezier(0.55, 0.06, 0.68, 0.19)`, 
                style({ height: '0px', opacity: 0, transform: 'translateY(-10px)' }))
      ])
    ]);
  }

  /**
   * Slide toggle animations (for collapsible content)
   */
  static slideToggle(duration = '300ms'): AnimationTriggerMetadata {
    return trigger('slideToggle', [
      state('hidden', style({ 
        height: '0px', 
        opacity: 0, 
        padding: 0, 
        overflow: 'hidden' 
      })),
      state('visible', style({ 
        height: '*', 
        opacity: 1, 
        padding: '*', 
        overflow: 'hidden' 
      })),
      transition('hidden <=> visible', animate(`${duration} ease-in-out`))
    ]);
  }

  /**
   * Overlay animations
   */
  static slideOverlay(
    enterDuration = '200ms', 
    leaveDuration = '200ms'
  ): AnimationTriggerMetadata {
    return trigger('slideOverlay', [
      transition(':enter', [
        style({ transform: 'translateX(100%)' }),
        animate(`${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ transform: 'translateX(0%)' }))
      ]),
      transition(':leave', [
        animate(`${leaveDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ transform: 'translateX(100%)' }))
      ])
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
        style({ opacity: 0, transform: 'scale(0.95)' }),
        animate(`${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ opacity: 1, transform: 'scale(1)' }))
      ]),
      transition(':leave', [
        animate(`${leaveDuration} cubic-bezier(0.55, 0.06, 0.68, 0.19)`, 
                style({ opacity: 0, transform: 'scale(0.95)' }))
      ])
    ]);
  }

  static contentFadeIn(
    duration = '500ms', 
    delay = '200ms'
  ): AnimationTriggerMetadata {
    return trigger('contentFadeIn', [
      transition(':enter', [
        style({ opacity: 0, transform: 'translateY(20px)' }),
        animate(`${duration} ${delay} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ opacity: 1, transform: 'translateY(0)' }))
      ])
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
        style({ opacity: 0, transform: 'scale(0.8)' }),
        animate(`${enterDuration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`, 
                style({ opacity: 1, transform: 'scale(1)' }))
      ]),
      transition(':leave', [
        animate(`${leaveDuration} cubic-bezier(0.55, 0.06, 0.68, 0.19)`, 
                style({ opacity: 0, transform: 'scale(0.8)' }))
      ])
    ]);
  }

  /**
   * Complex slide animation for multi-step components
   */
  static slideAnimation(duration = '300ms'): AnimationTriggerMetadata {
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
                `${duration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
                style({ transform: 'translateX(0)', opacity: 1 })
              ),
            ],
            { optional: true }
          ),
          query(
            ':leave',
            [
              animate(
                `${duration} cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
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
        style({ opacity: 0, transform: 'translateY(10px)' }),
        animate(
          `${enterDuration} ease-out`,
          style({ opacity: 1, transform: 'translateY(0)' })
        ),
      ]),
      transition(':leave', [
        animate(
          `${leaveDuration} ease-in`,
          style({ opacity: 0, transform: 'translateY(-10px)' })
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
      }
    });
    
    return animations;
  }
}
