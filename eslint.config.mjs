// ESLint (düz yapılandırma). CI'da hata → kırmızı; uyarı → yalnızca raporlanır.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

export default [
  {
    ignores: [
      'node_modules/**', '.next/**', 'out/**', 'next-env.d.ts', 'prototype/**',
      'playwright-report/**', 'test-results/**', 'server/geo/ranges.js', 'uploads/**', '.uploads/**',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-console': 'off',
    },
  },
];
