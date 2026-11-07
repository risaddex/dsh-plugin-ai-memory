#!/usr/bin/env node
/**
 * Verify every package's browser half stays loadable.
 *
 * A client half is one entry file (`exports["./client"]`) that registers itself
 * through `window.__ModuleLoader__.load({ id, factory })`. A larger panel can be
 * split into package-local chunks loaded with `require.async("./client.<name>.js")`,
 * but the split is only real if: the chunk sits next to the entry, its filename
 * matches the loader's CLIENT_CHUNK pattern, and the chunk registers under the
 * same package id with `chunk: "<file>"`. Get any of those wrong and the panel
 * breaks at runtime in the browser — long after the build and the install.
 *
 * Usage: node scripts/check-client-halves.mjs [package-dir ...]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/
const ASYNC = /require\.async\(\s*['"]\.\/([^'"]+)['"]\s*\)/g
const REGISTRATION = /__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/g

const problems = []
const fail = (message) => problems.push(message)

const args = process.argv.slice(2)
const packages = args.length > 0
  ? args
  : existsSync(join(root, 'packages'))
    ? readdirSync(join(root, 'packages')).map((slug) => join(root, 'packages', slug)).filter((dir) => existsSync(join(dir, 'package.json')))
    : [root]

const filesCover = (files, path) => {
  if (!Array.isArray(files)) return true
  const clean = path.replace(/^\.\//, '')
  return files.some((entry) => {
    const base = String(entry).replace(/^\.\//, '').replace(/\/+$/, '').replace(/\/\*.*$/, '')
    return base !== '' && (clean === base || clean.startsWith(base + '/'))
  })
}

let chunks = 0
for (const dir of packages) {
  if (!existsSync(join(dir, 'package.json'))) { fail(dir + ': no package.json'); continue }
  // A nested checkout (vendored submodule, cloned third-party package) is not ours to police;
  // the package under test at the script's own root always is.
  if (resolve(dir) !== resolve(root) && existsSync(join(dir, '.git'))) {
    console.log('check-client-halves: skipping third-party checkout ' + relative(root, dir))
    continue
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (pkg.dsh?.client === undefined) continue

  const exported = pkg.exports?.['./client']
  const rel = typeof exported === 'string' ? exported : exported?.default
  if (typeof rel !== 'string') { fail(pkg.name + ': dsh.client declared but exports["./client"] is missing'); continue }
  const entry = join(dir, rel)
  if (!existsSync(entry) || !statSync(entry).isFile()) { fail(pkg.name + ': client entry ' + rel + ' does not exist'); continue }

  const code = readFileSync(entry, 'utf8')
  const entryId = [...code.matchAll(REGISTRATION)].map((m) => m[1])[0]
  if (entryId !== pkg.name) fail(pkg.name + ': entry registers as "' + String(entryId) + '" instead of the package name')

  for (const match of code.matchAll(ASYNC)) {
    const name = match[1]
    if (!CHUNK.test(name)) { fail(pkg.name + ': require.async("./' + name + '") does not match the loader chunk pattern client.<name>.js'); continue }
    const chunkPath = join(dirname(entry), name)
    if (!existsSync(chunkPath)) { fail(pkg.name + ': chunk ' + name + ' is requested but does not sit next to the entry'); continue }
    chunks += 1

    const body = readFileSync(chunkPath, 'utf8')
    const id = [...body.matchAll(REGISTRATION)].map((m) => m[1])[0]
    if (id !== pkg.name) fail(pkg.name + ': chunk ' + name + ' registers as "' + String(id) + '" instead of the package name')
    if (!body.includes('chunk: "' + name + '"')) fail(pkg.name + ': chunk ' + name + ' does not register with chunk: "' + name + '"')

    const relativeChunk = relative(dir, chunkPath).split('\\').join('/')
    if (!filesCover(pkg.files, relativeChunk)) {
      fail(pkg.name + ': ' + relativeChunk + ' is outside package.json files[] — an npm publish would drop it (git installs are fine)')
    }
  }
}

if (problems.length > 0) {
  console.error('check-client-halves: ' + problems.length + ' problem(s)')
  for (const problem of problems) console.error('  - ' + problem)
  process.exit(1)
}
console.log('check-client-halves: ok — ' + String(packages.length) + ' package(s), ' + String(chunks) + ' chunk(s)')
