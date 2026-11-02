import { provideHttpClient, withXhr } from '@angular/common/http';
import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    // XHR instead of fetch: only XHR reports upload progress (document upload, prompt 009).
    provideHttpClient(withXhr()),
  ],
};
