import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'tsdown'

const isWatch = process.argv.includes('--watch') || process.argv.includes('-w')
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string }
const id = JSON.stringify(pkg.name)

const external = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'dsh-tauri/client',
  'dsh-tauri-ui/client',
  /^@deepseek-ai\//,
]

const clientInline = [/^(ofetch|hookable|unstorage)([/-].*)?$/]

export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'chat-policy': 'src/chat-policy.ts' },
    outDir: 'dist',
    format: 'esm',
    platform: 'node',
    outExtensions: () => ({ js: '.js' }),
    external,
    dts: false,
    clean: true,
    sourcemap: false,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'dist',
    format: 'cjs',
    platform: 'browser',
    external,
    noExternal: clientInline,
    outExtensions: () => ({ js: '.cjs' }),
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    banner: {
      js: `window.__ModuleLoader__.load({id:${id},factory:(require)=>{const loaderRequire=require;const resolve=(specifier)=>specifier.endsWith('/client')?specifier.slice(0,-7):specifier;require=(specifier)=>loaderRequire(resolve(specifier));var module={exports:{}};var exports=module.exports;`,
    },
    footer: { js: 'return module.exports;}});' },
    minify: !isWatch,
    sourcemap: true,
    dts: false,
    clean: false,
  },
])
