// @ts-check
import angular from 'angular-eslint';
import tseslint from 'typescript-eslint';
import rootConfig from '../../eslint.config.js';

export default tseslint.config(
  ...rootConfig,
  {
    files: ['**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      // Decorated component classes are legitimately empty (template-only components).
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'rl', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'rl', style: 'kebab-case' },
      ],
      // Security guard rails (docs/security.md): untrusted text is only ever interpolated.
      'no-restricted-properties': [
        'error',
        ...['innerHTML', 'outerHTML', 'insertAdjacentHTML'].map((property) => ({
          property,
          message: 'Do not write HTML strings into the DOM; interpolate text instead.',
        })),
        { object: 'document', property: 'write', message: 'document.write is not allowed.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[property.name=/^bypassSecurityTrust/]',
          message: 'Bypassing Angular sanitisation is not allowed (docs/security.md).',
        },
      ],
    },
  },
  {
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    rules: {
      // Also covers inline templates (processInlineTemplates): no HTML bindings, and links that
      // open a new tab must not hand `window.opener` or the referrer to the target.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'BoundAttribute[name=/^(innerHTML|outerHTML|srcdoc)$/]',
          message: 'Do not bind HTML; interpolate untrusted text instead (docs/security.md).',
        },
        {
          selector:
            'Element:has(> TextAttribute[name="target"][value="_blank"]):not(:has(> TextAttribute[name="rel"][value=/noopener/][value=/noreferrer/]))',
          message: 'Links with target="_blank" need rel="noopener noreferrer".',
        },
        {
          selector: 'BoundAttribute[name="target"]',
          message: 'Use a static target; links opening new tabs need rel="noopener noreferrer".',
        },
      ],
    },
  },
);
