import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ThemeService } from './core/theme/theme.service';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

@Component({
  selector: 'rl-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  // Instantiating the service applies the stored theme on startup.
  protected readonly theme = inject(ThemeService);

  protected readonly navItems: readonly NavItem[] = [
    { path: '/knowledge-bases', label: 'Knowledge Bases', icon: '▤' },
    { path: '/chat', label: 'Chat', icon: '✉' },
    { path: '/playground', label: 'Retrieval Playground', icon: '⌕' },
    { path: '/settings', label: 'Settings', icon: '⚙' },
  ];
}
