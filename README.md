# Okane

The project architecture and agent contracts are in [the architecture guide](docs/ARCHITECTURE.md). Teammate/agent working conventions are in [AGENTS.md](AGENTS.md). Track the six-hour build through the [GitHub issues](https://github.com/maaaazin/Okane/issues).

## Local development

1. Use Node.js 20.9 or later.
2. Copy `.env.example` to `.env.local` and add only the credentials required for your local run. Do not commit `.env.local`.
3. Install dependencies with `npm install`.
4. Start the development server with `npm run dev`, then open [http://localhost:3000](http://localhost:3000).

Before opening a pull request, run `npm run lint` and `npm run typecheck`.
