import { Injectable } from '@angular/core';
import { ANIMATION_CONSTANTS, AnimationConfig } from '@app/types';

@Injectable({
  providedIn: 'root',
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
          easing: ANIMATION_CONSTANTS.EASING.SMOOTH,
        };
      case 'leave':
        return {
          duration: ANIMATION_CONSTANTS.DURATION.FAST,
          delay: '0ms',
          easing: ANIMATION_CONSTANTS.EASING.SHARP,
        };
      case 'toggle':
        return {
          duration: ANIMATION_CONSTANTS.DURATION.NORMAL,
          delay: '0ms',
          easing: ANIMATION_CONSTANTS.EASING.EASE_IN_OUT,
        };
      default:
        return {
          duration: ANIMATION_CONSTANTS.DURATION.NORMAL,
          delay: '0ms',
          easing: ANIMATION_CONSTANTS.EASING.SMOOTH,
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
      easing: userConfig.easing || defaultConfig.easing,
    };
  }
}
