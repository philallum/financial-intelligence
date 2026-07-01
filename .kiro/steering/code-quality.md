---
inclusion: auto
---

# Code Quality & Linting Standards

This steering file enforces the Financial Intelligence Platform's code quality standards across all coding sessions. These are hard standards, not suggestions.

## TypeScript Configuration

- Strict mode enabled (`strict: true` in tsconfig.json)
- ES2022 target, NodeNext module resolution
- No implicit any, strict null checks, no unchecked indexed access
- All code must compile with zero TypeScript errors

## ESLint Rules (TypeScript Strict)

The project uses `@typescript-eslint/strict-type-checked` and `@typescript-eslint/stylistic-type-checked`.

Key rules that MUST be followed when writing code:
- **No `any` types** — use proper typing, generics, or `unknown`
- **No unused variables** — remove or prefix with `_` if intentionally unused
- **No floating promises** — always `await` or explicitly handle with `.catch()`
- **Consistent type imports** — use `import type { X }` for type-only imports
- **No non-null assertions** — use proper null checks instead of `!`
- **No explicit any in function parameters or return types**

## Prettier Formatting

All code MUST be formatted with these settings:
- Single quotes (`'`)
- Semicolons required
- 2-space indent
- Trailing commas everywhere (`'all'`)
- 100 character line width
- Always use parentheses for arrow function parameters
- LF line endings (no CRLF)

## When Writing Code

1. Always use `const` over `let` where the variable is not reassigned
2. Prefer `interface` over `type` for object shapes (unless union/intersection needed)
3. Use `readonly` for properties that should not be mutated
4. All functions that return promises must be `async` or explicitly return `Promise<T>`
5. Use early returns to reduce nesting
6. Name files in kebab-case (e.g., `fingerprint-engine.ts`)
7. Name interfaces in PascalCase (e.g., `FingerprintInput`)
8. Name constants in UPPER_SNAKE_CASE (e.g., `FLAT_THRESHOLD`)

## Dependency Rules

- All dependencies MUST use exact versions (no `^` or `~` in package.json)
- Always install the latest stable version of any new dependency
- Use Node.js LTS (current latest LTS)
- Verify compatibility before adding any dependency
- **CRITICAL: When installing ESLint, typescript-eslint, Prettier, TypeScript, or any tooling dependency, always check npm for the current latest major version at time of install. Do not default to older major versions from prior training data or cached knowledge. Run `npm info <package> version` to confirm the latest before installing.**
- If unsure whether a version is current, search the web for the latest release before proceeding

## Testing Standards

- Use Vitest for all tests
- Use fast-check for property-based tests
- Tests live in `tests/` directory mirroring `src/` structure
- Test files named `*.test.ts`
- Property tests named `*.property.test.ts`
- Minimum 100 iterations for property-based tests
