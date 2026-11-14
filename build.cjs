const { build, context } = require('esbuild');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const watch = process.argv.includes('--watch');
const output = path.join(__dirname, 'public/assets');
fs.mkdirSync(output, { recursive: true });
const options = {
  absWorkingDir: __dirname,
  entryPoints: ['frontend/storefront.jsx'],
  outfile: 'public/assets/storefront.js',
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: ['es2020'],
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
};

async function main() {
  if (watch) {
    const compiler = await context(options);
    await compiler.watch();
  } else {
    await build(options);
  }
  const cli = path.join(path.dirname(require.resolve('@tailwindcss/cli/package.json')), 'dist/index.mjs');
  const css = spawn(process.execPath, [cli, '-i', 'frontend/styles.css', '-o', 'public/assets/tailwind.css', ...(watch ? ['--watch=always'] : ['--minify'])], {
    cwd: __dirname, stdio: 'inherit',
  });
  css.on('error', error => { console.error(error); process.exit(1); });
  css.on('exit', code => { if (code) process.exit(code); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { css.kill(); process.exit(); });
}
main().catch(error => { console.error(error); process.exit(1); });
