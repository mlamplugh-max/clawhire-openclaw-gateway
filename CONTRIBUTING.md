# Contributing

Thanks for looking. This is a small, focused runtime, and contributions that keep it small are the easiest to take.

## Running it locally

- Node 20 or newer.
- `npm ci`
- `npm run typecheck` — TypeScript, no emit.
- `npm run contract-test` — the `/agents/*` contract against the stub engine. No model key, no network.
- `npm run dev` — the adapter on the stub engine at `http://localhost:8000`.

Every pull request runs the same typecheck and contract test in CI, on Node 20 and 22.

## What is welcome

- Bug fixes, with a test in `test/` when the bug is reachable through the contract.
- Documentation fixes.
- Support for running the worker on other hosts. The Fly config is a default, not a requirement.
- Adapters for other agent engines behind `src/openclaw/engine.ts`, as long as the stub engine and the contract test keep passing.

## What needs a discussion first

- Changes to the `/agents/*` request or response shapes. The contract is frozen; a change means a new contract version, not an edit to the current one. Open an issue and say what your control plane needs.
- Anything that stores customer credentials on the worker. The design rule is borrow and expire; see the tenant-isolation section of the README.

## Style

- TypeScript, strict. No new runtime dependencies without a reason in the pull request description.
- Keep secrets out of tests and fixtures; the contract test generates its own keys.

## Licence

By contributing you agree that your contribution is licensed under the repository's [Elastic License 2.0](./LICENSE).
