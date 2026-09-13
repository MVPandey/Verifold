# Official documentation

These references accompany the installed Node.js skill v1.1, reviewed on 2026-09-07. Verify current contracts before adopting changes.

## Official references

- [Node TypeScript support](https://nodejs.org/api/typescript.html): type stripping does not check types or read tsconfig; runtime restrictions and module import rules.
- [Node test runner](https://nodejs.org/api/test.html): native testing, discovery, mocks, and version-dependent coverage support. The executable fixture uses emitted JavaScript for compatibility.
- [Node release lifecycle](https://nodejs.org/en/about/previous-releases): select a supported LTS and verify compatibility rather than permanently encoding a moving latest version.
- [typescript-eslint typed linting](https://typescript-eslint.io/getting-started/typed-linting/): type-aware lint configuration and project service.
- [TypeScript strict](https://www.typescriptlang.org/tsconfig/strict.html): compiler strictness is distinct from lint and runtime validation.
- [Prettier CLI](https://prettier.io/docs/cli): check mode for validation; write mode for explicit formatting.
- [Node security guidance](https://nodejs.org/en/learn/getting-started/security-best-practices): denial-of-service, dependency, and prototype-pollution concerns informed the boundary checklist.
- [Git hooks](https://git-scm.com/docs/githooks): executable hooks, local hook path, and pre-commit exit/bypass behavior.
- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches): require CI status checks to protect merges; a local hook alone cannot enforce that policy.
- [ESLint version support](https://eslint.org/version-support/): ESLint 9 reached EOL in August 2026; the verified template uses ESLint 10.
- [typescript-eslint dependency versions](https://typescript-eslint.io/users/dependency-versions/): verified ESLint 10 and TypeScript 5.9 compatibility before testing the template.
