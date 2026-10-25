# Contributing to @nemau-cloud/sdk

Bug reports, fixes and improvements are welcome.

## Proposing a change

- To report a bug or discuss a feature, open an issue at
  <https://github.com/nemau-cloud/nemau-sdk-typescript/issues>. For a bug, include
  the SDK version, the Node.js version, the method you called and the error.
  Remove credentials and secrets from what you paste.
- To propose a change, open a pull request against `main` on
  <https://github.com/nemau-cloud/nemau-sdk-typescript>. For a larger change, open an
  issue first to agree on the approach.
- Do not report security vulnerabilities in issues. See
  [SECURITY.md](SECURITY.md).

## Building and testing

The package supports Node.js 18 and later. The tests run TypeScript files
directly through Node's type stripping, which needs a recent Node.js; the CI
uses Node.js 26.

```sh
npm ci
npm run typecheck   # tsc --noEmit over src/ and test/
npm test            # node --test, no third-party runner
npm run build       # compiles src/ to dist/
npm run check       # the three steps above, in order
```

A pull request must pass `npm run check`.

Sources import each other with the `.ts` extension, so Node can run the tests
without a build step. At build time, `rewriteRelativeImportExtensions` rewrites
the specifiers to `.js`. `erasableSyntaxOnly` is enabled: use only TypeScript
syntax that can be erased, which excludes `enum`, `namespace` and parameter
properties.

## Guidelines

- The package has no runtime dependencies and uses the runtime's built-in
  `fetch`. Keep it that way; if a change seems to need a dependency, raise it in
  an issue first.
- Add or update tests in `test/` for every change in behaviour. The tests run
  against a local HTTP stub (`test/helpers.ts`), never against the live API.
- Document exported classes, methods and types with TSDoc comments, and update
  the guide in [docs/](docs/README.md) when a change affects it.
- The SDK only calls the public API under `/api/v1`. Use example values that
  are clearly fictitious, such as `example.com` and documentation IP ranges.

## Commit messages

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
a type, an optional scope, and a short summary in the imperative mood.

```text
fix(storage): keep the marker when a listing page is empty
feat(dns): add verifyZoneAndWait
docs: describe the retry policy
```

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `build` and `ci`.

## Changelog

Record every user-visible change in [CHANGELOG.md](CHANGELOG.md), under
`## [Unreleased]`, in the section that fits (`Added`, `Changed`, `Removed`,
`Fixed`). The file follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
