import { ErrorHandler, Injectable, NgZone } from '@angular/core';

@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  constructor(private zone: NgZone) {}

  handleError(error: any): void {
    console.error('Global error caught:', error);
    
    // Run error handling inside Angular zone to ensure UI updates
    this.zone.run(() => {
      // You can add custom error handling logic here
      // For now, just log the error
      console.error('Error details:', {
        message: error?.message,
        stack: error?.stack,
        name: error?.name
      });
    });
  }
}
