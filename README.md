# Okane

CA3 planning, build stages, agent contracts, and team collaboration guidance are in [the project roadmap](docs/PROJECT_ROADMAP.md).

For the six-hour build, use the [PR-sized GitHub issue backlog](docs/HACKATHON_ISSUES.md).

## Local development

1. Use Node.js 20.9 or later.
2. Copy `.env.example` to `.env.local` and add only the credentials required for your local run. Do not commit `.env.local`.
3. Install dependencies with `npm install`.
4. Start the development server with `npm run dev`, then open [http://localhost:3000](http://localhost:3000).

Before opening a pull request, run `npm run lint` and `npm run typecheck`.
