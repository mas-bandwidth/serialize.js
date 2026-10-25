// The lint gate: `npm run lint`, a failing CI check.
//
// The package carries zero dependencies, ESLint included: CI runs one
// pinned ESLint release through npx, and this configuration imports
// nothing, so the rules are spelled out here rather than pulled from a
// preset package. They are ESLint's recommended set, every one an error,
// plus strict equality and no `var`; a warning is not a state this
// repository ships in, so the gate also runs with --max-warnings 0.

const NODE_GLOBALS = {
  console: 'readonly',
  process: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  URL: 'readonly',
};

const RECOMMENDED = [
  'constructor-super', 'for-direction', 'getter-return', 'no-async-promise-executor',
  'no-case-declarations', 'no-class-assign', 'no-compare-neg-zero', 'no-cond-assign',
  'no-const-assign', 'no-constant-binary-expression', 'no-constant-condition',
  'no-control-regex', 'no-debugger', 'no-delete-var', 'no-dupe-args', 'no-dupe-class-members',
  'no-dupe-else-if', 'no-dupe-keys', 'no-duplicate-case', 'no-empty', 'no-empty-character-class',
  'no-empty-pattern', 'no-empty-static-block', 'no-ex-assign', 'no-extra-boolean-cast',
  'no-fallthrough', 'no-func-assign', 'no-global-assign', 'no-import-assign',
  'no-invalid-regexp', 'no-irregular-whitespace', 'no-loss-of-precision',
  'no-misleading-character-class', 'no-new-native-nonconstructor', 'no-nonoctal-decimal-escape',
  'no-obj-calls', 'no-octal', 'no-octal-escape', 'no-prototype-builtins', 'no-redeclare',
  'no-regex-spaces', 'no-self-assign', 'no-setter-return', 'no-shadow-restricted-names',
  'no-sparse-arrays', 'no-this-before-super', 'no-undef', 'no-unexpected-multiline',
  'no-unreachable', 'no-unsafe-finally', 'no-unsafe-negation', 'no-unsafe-optional-chaining',
  'no-unused-labels', 'no-unused-private-class-members', 'no-useless-catch', 'no-useless-escape',
  'no-with', 'require-yield', 'use-isnan', 'valid-typeof',
];

export default [
  { ignores: ['.controls/**', 'node_modules/**', 'fuzz/node_modules/**', 'fuzz/.sabotage/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      ...Object.fromEntries(RECOMMENDED.map((rule) => [rule, 'error'])),
      // the serialize surface is one signature on every stream: a measure
      // ignores the ref a write consumes, by design
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
    },
  },
];
