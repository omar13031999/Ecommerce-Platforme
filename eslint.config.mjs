import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

export default [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  // <a> is intentional for file downloads from /api routes (not page navigation)
  { rules: { '@next/next/no-html-link-for-pages': 'off' } },
  { ignores: ['.next/**', 'node_modules/**', 'src/lib/database.types.ts'] },
];
