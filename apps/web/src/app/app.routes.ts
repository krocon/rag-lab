import type { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Welcome · RAGLab',
    loadComponent: () => import('./features/welcome/welcome-page').then((m) => m.WelcomePage),
  },
  {
    path: 'knowledge-bases',
    title: 'Knowledge Bases · RAGLab',
    loadComponent: () =>
      import('./features/knowledge-bases/knowledge-bases-page').then((m) => m.KnowledgeBasesPage),
  },
  {
    path: 'chat',
    title: 'Chat · RAGLab',
    loadComponent: () => import('./features/chat/chat-page').then((m) => m.ChatPage),
  },
  {
    path: 'playground',
    title: 'Retrieval Playground · RAGLab',
    loadComponent: () =>
      import('./features/playground/playground-page').then((m) => m.PlaygroundPage),
  },
  {
    path: 'settings',
    title: 'Settings · RAGLab',
    loadComponent: () => import('./features/settings/settings-page').then((m) => m.SettingsPage),
  },
  {
    path: '**',
    title: 'Not found · RAGLab',
    loadComponent: () => import('./features/not-found-page').then((m) => m.NotFoundPage),
  },
];
