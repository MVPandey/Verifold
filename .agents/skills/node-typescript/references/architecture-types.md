# Architecture, types, and maintainability

## Responsibilities and layout

Organize by domain when the application grows: src/orders/domain.ts, service.ts, repository.ts, and routes.ts. A small library may need only a few modules. Use adapters for database/HTTP/filesystem concerns and a bootstrap entrypoint for wiring. Avoid catch-all utils modules, circular imports, speculative interfaces, and inheritance used only for code sharing. Prefer functions and composition; use classes when they own meaningful state or a lifecycle.

Inject dependencies as parameters or constructor arguments. Do not introduce a DI container merely to satisfy this rule. Domain interfaces should describe required behavior, not duplicate an entire vendor SDK. Transactions belong to a use case; enforce uniqueness and concurrency invariants in the database too. Use idempotency keys or an outbox when retries cross a durable database/external-system boundary.

Libraries expose a deliberate package.json exports map, declarations, and compatible engines. Test the packed artifact when changing package exports. Services own startup, health/readiness, dependency pools, and graceful shutdown. Reuse resources that support pooling; close them once at shutdown. Bound caches by size and lifetime and account for tenant identity in cache keys.

## Types are contracts, not input validation

Enable strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, noFallthroughCasesInSwitch, and forceConsistentCasingInFileNames for new TypeScript projects. Include tests in a checking tsconfig. Preserve framework compiler settings and project references in existing repositories.

Use unknown at JSON, request, environment, queue, and error boundaries. Validate shape, limits, and domain constraints with the project's schema validator or small explicit guards. There is no built-in general Node schema validator; use an established dependency when schemas warrant it. Avoid handwritten replacements for a validator already in the project.

Prefer discriminated unions for states and exhaustive switches for closed unions. Use satisfies to check a value without unnecessarily widening its inferred type. Prefer built-in Pick, Omit, Readonly, and Partial over elaborate conditional types. Use generics only when they preserve an actual relationship between inputs and outputs. Avoid any, non-null assertions, double assertions, and blanket suppression. A necessary @ts-expect-error needs a specific reason and narrow scope; never use @ts-ignore to hide unfinished work.

Model optional properties deliberately: absent and present-with-undefined are different with exactOptionalPropertyTypes. Use readonly T[], ReadonlyMap, and ReadonlySet at read-only boundaries, but remember other aliases can still mutate the same object. Use copies or controlled ownership when isolation matters. Object.freeze does not freeze nested data or Map/Set contents.

## Runtime and module agreement

For compiled ESM, use NodeNext resolution, type: module, and .js extensions on relative imports in TypeScript. tsc resolves the source .ts and emits imports that Node can load. Avoid tsconfig paths aliases unless runtime resolution is implemented. Keep production emission separate from test emission and fail builds on type errors.

For direct TypeScript execution, verify the exact runtime's type-stripping support and use erasableSyntaxOnly, verbatimModuleSyntax, and appropriate .ts imports. Node does not type-check or read tsconfig when stripping types; tsc --noEmit remains required. Native stripping does not support TSX or code-generating TypeScript constructs such as enums and parameter properties. Published libraries should ship JavaScript and declarations. Do not switch a bundler-based frontend to NodeNext just because it uses TypeScript.

For JavaScript maintenance, retain JavaScript and use JSDoc with checkJs where appropriate; do not force a language migration.

## Errors, configuration, and documentation

Use Error subclasses or a discriminated result type according to repo conventions. Define a package-level hierarchy only when callers need to distinguish failures. Throw Error objects, preserve the original exception with new Error(message, { cause }), and narrow catch values before access. Translate internal failures to safe HTTP responses at the edge. Log an error once where its outcome is decided.

Parse environment values explicitly: Boolean('false') is true, and Number('') is zero. Reject invalid/missing required settings at startup; test ranges and cross-field constraints. Keep secrets out of checked-in defaults and examples.

Use JSDoc for exported behavior that types alone cannot explain: units, invariants, cancellation, I/O, and thrown errors. Avoid arbitrary file-size limits; split modules when responsibilities diverge. Reuse standard URL, crypto, and stream functionality instead of duplicating it.
