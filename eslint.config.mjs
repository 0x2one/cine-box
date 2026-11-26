import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  // tmp / .tmp 是 .gitignore 里的本地草稿目录（截图、临时脚本），不参与 lint
  { ignores: ['**/node_modules', '**/dist', '**/out', '**/tmp', '**/.tmp'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // 发版用的纯 Node 脚本没有类型层，无法标注返回类型
    files: ['scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    // 局域网影院网页端是直接由主进程托管的纯浏览器 JS：没有 TS 类型层，
    // 不要求返回类型；catch 里只用来兜底的变量也允许不引用。
    files: ['src/lanweb/**/*.js'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }]
    }
  },
  eslintConfigPrettier
)
