import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

mkdirSync('dist', { recursive: true });

// Win+Space hotkey helper (see src/native/HotkeyHelper.cs). Compiled with the
// .NET Framework csc that ships with Windows; skipped gracefully elsewhere.
if (process.platform === 'win32') {
  const src = 'src\\native\\HotkeyHelper.cs';
  const exe = 'dist\\hotkey-helper.exe';
  const stale = !existsSync(exe) || statSync(exe).mtimeMs < statSync(src).mtimeMs;
  if (stale) {
    const csc = path.join(
      process.env.WINDIR ?? 'C:\\Windows',
      'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'
    );
    if (existsSync(csc)) {
      const res = spawnSync(csc, ['/nologo', '/optimize', `/out:${exe}`, src], { stdio: 'inherit' });
      if (res.status !== 0) console.warn('hotkey helper compile failed; app will use fallback shortcut');
    } else {
      console.warn('csc.exe not found; app will use fallback shortcut');
    }
  }
}

const common = { bundle: true, sourcemap: 'inline', logLevel: 'warning' };

await build({
  ...common,
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist/main.cjs',
  platform: 'node',
  format: 'cjs',
  packages: 'external'
});

await build({
  ...common,
  entryPoints: ['src/preload/preload.ts'],
  outfile: 'dist/preload.cjs',
  platform: 'node',
  format: 'cjs',
  external: ['electron']
});

await build({
  ...common,
  entryPoints: ['src/preload/settings-preload.ts'],
  outfile: 'dist/settings-preload.cjs',
  platform: 'node',
  format: 'cjs',
  external: ['electron']
});

await build({
  ...common,
  entryPoints: ['src/renderer/overlay.ts'],
  outfile: 'dist/overlay.js',
  platform: 'browser',
  format: 'iife'
});

await build({
  ...common,
  entryPoints: ['src/renderer/settings.ts'],
  outfile: 'dist/settings.js',
  platform: 'browser',
  format: 'iife'
});

cpSync('src/renderer/overlay.html', 'dist/overlay.html');
cpSync('src/renderer/overlay.css', 'dist/overlay.css');
cpSync('src/renderer/settings.html', 'dist/settings.html');
cpSync('src/renderer/settings.css', 'dist/settings.css');
console.log('build ok');
