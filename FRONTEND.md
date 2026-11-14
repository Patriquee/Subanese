React and Tailwind frontend
===========================

Requirements: Node.js 26+ and npm (the server uses node:sqlite).

    npm install
    npm run dev

Open http://localhost:3000. Development watches both the Node server and frontend
sources, and the existing browser version check reloads rebuilt assets.
On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.

For production, use `npm start`; it builds the frontend before starting the server.
Use `npm run build` to build assets alone and `npm test` to run the test suite.
When starting with `node server.cjs` directly, build assets first.

`frontend/storefront.jsx` provides React product cards for featured bakes, shop
results, and recently viewed items. Existing photo, pricing, product details, and
cart functions are passed to React through a small bridge in `bindAddButtons()`.
React roots are unmounted when routes or filters remove their containers.
Other screens continue to use the existing browser code.

`frontend/styles.css` compiles Tailwind v4 utilities. Utilities use the `tw:` prefix
(for example `tw:w-full`) and omit Preflight to preserve the existing design.
`storefront.css` remains the shared stylesheet. Add new utilities as literal class
names in frontend sources or server.cjs so Tailwind can detect them.
Product-card layout, spacing, typography, image sizing, focus styles, and button
dimensions are implemented with Tailwind `@apply` in `frontend/styles.css`.
The same compiled styles cover both the initial HTML and the React cards.

`build.cjs` bundles React locally with esbuild and compiles Tailwind with its CLI.
Generated files live in `public/assets/` and are served by the Node server at
`/assets/storefront.js` and `/assets/tailwind.css`; no frontend CDN is required.
