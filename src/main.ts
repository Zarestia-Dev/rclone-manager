// Polyfill for Promise.allSettled on older WebKit versions (Safari < 13)
if (typeof Promise.allSettled !== 'function') {
  Promise.allSettled = function (promises: any[]): Promise<any> {
    return Promise.all(
      promises.map(p =>
        Promise.resolve(p).then(
          value => ({ status: 'fulfilled', value }),
          reason => ({ status: 'rejected', reason })
        )
      )
    );
  } as any;
}

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig).catch(err => console.error(err));
