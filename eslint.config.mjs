import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends(
    'next/core-web-vitals',
    'next/typescript',
    'plugin:import/recommended',
    'prettier',
    'plugin:prettier/recommended'
  ),
  {
    files: ['**/*.test.{ts,tsx}'],
    rules: {
      // Testing Library's conditional exports are valid at runtime but opaque to import/named.
      'import/named': 'off',
    },
  },
];

export default eslintConfig;
