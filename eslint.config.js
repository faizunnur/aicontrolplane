// Focused lint: the rules that catch what the compiler cannot once the data layer is async —
// a write nobody awaited (silent reordering on Postgres) or a Promise used as a condition.
import tseslint from "typescript-eslint";

const languageOptions = {
  parser: tseslint.parser,
  parserOptions: { project: "./tsconfig.test.json", tsconfigRootDir: import.meta.dirname },
};

export default tseslint.config(
  {
    files: ["src/**/*.ts", "packages/**/*.ts", "scripts/**/*.ts"],
    languageOptions,
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // Tests run under node:test whose describe/it return promises the runner owns; only the
    // condition-misuse rule earns its keep here.
    files: ["test/**/*.ts"],
    languageOptions,
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
    },
  },
);
