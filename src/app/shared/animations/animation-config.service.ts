import { Injectable } from '@angular/core';

/**
 * Animation constants for consistent timing and easing
 */
export const ANIMATION_CONSTANTS = {
  // Durations
  DURATION: {
    FAST: '200ms',
    NORMAL: '300ms',
    SLOW: '500ms',
    EXTRA_SLOW: '600ms'
  },
  
  // Easing functions
  EASING: {
    EASE_IN_OUT: 'ease-in-out',
    EASE_IN: 'ease-in',
    EASE_OUT: 'ease-out',
    SMOOTH: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    SHARP: 'cubic-bezier(0.55, 0.06, 0.68, 0.19)'
  },
  
  // Common delays
  DELAY: {
    SHORT: '100ms',
    MEDIUM: '200ms',
    LONG: '300ms'
  }
};

/**
 * Animation configuration interface
 */
export interface AnimationConfig {
  duration?: string;
  delay?: string;
  easing?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AnimationConfigService {
  
  /**
   * Get default configuration for different animation types
   */
  static getDefaultConfig(type: 'enter' | 'leave' | 'toggle'): AnimationConfig {
    switch (type) {
      case 'enter':
        return {
          duration: ANIMATION_CONSTANTS.DURATION.NORMAL,
          delay: '0ms',
          easing: ANIMATION_CONSTANTS.EASING.SMOOTH
        };
      case 'leave':
        return {
          duration: ANIMATION_CONSTANTS.DURATION.FAST,
          delay: '0ms',
          easing: ANIMATION_CONSTANTS.EASING.SHARP
        };
      case 'toggle':
        return {
          duration: ANIMATION_CONSTANTS.DURATION.NORMAL,
          delay: '0ms',
          easing: ANIMATION_CONSTANTS.EASING.EASE_IN_OUT
        };
      default:
        return {
          duration: ANIMATION_CONSTANTS.DURATION.NORMAL,
          delay: '0ms',
          easing: ANIMATION_CONSTANTS.EASING.SMOOTH
        };
    }
  }

  /**
   * Merge user config with defaults
   */
  static mergeConfig(userConfig: AnimationConfig, defaultConfig: AnimationConfig): AnimationConfig {
    return {
      duration: userConfig.duration || defaultConfig.duration,
      delay: userConfig.delay || defaultConfig.delay,
      easing: userConfig.easing || defaultConfig.easing
    };
  }
}
