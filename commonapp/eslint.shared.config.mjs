// Lints the cross-app modules in ../shared with the same rules as the apps.
// Run from commonapp: npm run lint:shared
import eslint from '@electron-toolkit/eslint-config'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default [
  eslint,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    files: ['shared/**/*.{js,jsx,mjs}'],
    languageOptions: { globals: { ...globals.browser } },
    settings: { react: { version: '19' } },
    plugins: { 'react-hooks': eslintPluginReactHooks },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      'react/prop-types': 'off'
    }
  },
  eslintConfigPrettier
]
