/**
 * Material intake tests: the disk half (`scanIntake` / `prepareBatch`) and the
 * ledger half (`reference.intake` apply), end to end.
 *
 * Run with: node --test host/test
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyOp, applyOps, emptyBoard } from '../board.js'
import { MAX_INTAKE_FILES, prepareBatch } from '../verify.js'

/**
 * @returns {Promise<string>} a fresh temporary directory.
 */
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'greenlight-intake-'))
}

/**
 * Write one file, creating its directory first.
 * @param root - directory the path is relative to.
 * @param path - relative file path.
 * @returns completion.
 */
async function makeFile(root, path) {
  const target = join(root, path)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, path, 'utf8')
}

/**
 * @param rootDir - project root directory, or ''.
 * @returns {object} a board with one project called `p`.
 */
function boardWithRoot(rootDir) {
  const board = emptyBoard()
  assert.equal(applyOp(board, { type: 'project.add', id: 'p', name: 'P', rootDir }), null)
  return board
}

/**
 * Prepare one intake operation and return `{ prepared }`.
 * @param board - board the op applies to.
 * @param paths - input paths and links.
 * @returns {Promise<object>} the prepared operation.
 */
async function prepareIntake(board, paths) {
  return (await prepareBatch(board, [{ type: 'reference.intake', projectId: 'p', paths }]))[0]
}

test('a directory scan adds its files and skips dependency and build directories', async () => {
  const dir = await tempDir()
  await makeFile(dir, 'a.md')
  await makeFile(dir, 'docs/b.md')
  await makeFile(dir, 'node_modules/x.js')
  await makeFile(dir, '.git/config')

  const board = boardWithRoot(dir)
  const prepared = await prepareIntake(board, [dir])
  assert.deepEqual(prepared.added.map(entry => entry.value), ['a.md', 'docs/b.md'], 'only real material is added')
  assert.deepEqual(prepared.added.map(entry => entry.name), ['a.md', 'b.md'])
  assert.deepEqual(prepared.missing, [])
  assert.deepEqual(prepared.skipped, [])
  assert.equal(prepared.truncated, false)
  for (const entry of prepared.added) assert.match(entry.id, /^ref-/)

  // Applying writes link references; a note or other kind would never be probed.
  const outcome = applyOps(board, [prepared])
  assert.deepEqual(outcome.rejected, [])
  const project = outcome.board.projects[0]
  assert.deepEqual(project.references.map(entry => entry.value), ['a.md', 'docs/b.md'])
  assert.deepEqual(project.references.map(entry => entry.name), ['a.md', 'b.md'])
  assert.deepEqual(project.references.map(entry => entry.kind), ['link', 'link'])
  for (const entry of project.references) {
    assert.equal(entry.description, '')
    assert.equal(entry.staleSince, 0)
  }

  // A second scan of the same tree adds nothing: every file is a duplicate.
  const again = await prepareIntake(outcome.board, [dir])
  assert.equal(again.added.length, 0)
  assert.deepEqual(again.skipped, ['a.md', 'docs/b.md'])

  // A path that cannot be found is reported, never added.
  const missingPath = join(dir, 'nope.md')
  const absent = await prepareIntake(outcome.board, [missingPath])
  assert.equal(absent.added.length, 0)
  assert.deepEqual(absent.missing, [missingPath])

  // Mixed input: one existing file, one absent path.
  const mixed = await prepareIntake(outcome.board, [join(dir, 'a.md'), missingPath])
  assert.equal(mixed.added.length, 0)
  assert.deepEqual(mixed.skipped, ['a.md'])
  assert.deepEqual(mixed.missing, [missingPath])
})

test('every app-generated directory name is skipped, at any depth', async () => {
  const dir = await tempDir()
  const skippedDirs = ['.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '.next', 'vendor', '__pycache__']
  for (const name of skippedDirs) await makeFile(dir, name + '/artifact.js')
  await makeFile(dir, 'docs/node_modules/nested.js')
  await makeFile(dir, 'docs/keep.md')

  const prepared = await prepareIntake(boardWithRoot(dir), [dir])
  assert.deepEqual(prepared.added.map(entry => entry.value), ['docs/keep.md'])
})

test('a directory contributes at most 200 files and marks the scan truncated', async () => {
  const dir = await tempDir()
  await mkdir(join(dir, 'many'), { recursive: true })
  const names = Array.from({ length: MAX_INTAKE_FILES + 5 }, (unused, index) => 'f' + String(index).padStart(3, '0') + '.txt')
  await Promise.all(names.map(name => writeFile(join(dir, 'many', name), name, 'utf8')))

  const prepared = await prepareIntake(boardWithRoot(dir), [dir])
  assert.equal(prepared.added.length, MAX_INTAKE_FILES)
  assert.equal(prepared.truncated, true, 'a clipped directory is called out')
  assert.equal(prepared.added[0].value, 'many/f000.txt', 'files are taken in name order')
  assert.equal(prepared.added[MAX_INTAKE_FILES - 1].value, 'many/f199.txt')
})

test('a repeated file name falls back to the fuller relative path', async () => {
  const dir = await tempDir()
  await makeFile(dir, 'spec/readme.md')
  await makeFile(dir, 'docs/readme.md')

  const prepared = await prepareIntake(boardWithRoot(dir), [dir])
  // The first file keeps its name; the one that collides is distinguished by
  // the fuller path, so a reader can tell the two apart.
  assert.deepEqual(prepared.added.map(entry => entry.name).sort(), ['readme.md', 'spec/readme.md'])
  assert.deepEqual(prepared.added.map(entry => entry.value).sort(), ['docs/readme.md', 'spec/readme.md'])

  // A name already used by a stored reference is treated the same way.
  const board = boardWithRoot(dir)
  assert.equal(applyOp(board, { type: 'reference.add', projectId: 'p', kind: 'link', name: 'readme.md', value: 'elsewhere.md' }), null)
  const preparedAgain = await prepareIntake(board, [dir])
  assert.deepEqual(preparedAgain.added.map(entry => entry.name).sort(), ['docs/readme.md', 'spec/readme.md'])
})

test('links are kept as given and named after their last path segment', async () => {
  const prepared = await prepareIntake(boardWithRoot(''), [
    'https://example.com/docs/guide.md',
    'https://example.com/docs/guide.md',
    'https://example.com/',
  ])
  assert.equal(prepared.added.length, 2, 'the repeated link is not added twice')
  assert.deepEqual(prepared.added.map(entry => entry.value), ['https://example.com/docs/guide.md', 'https://example.com/'])
  assert.equal(prepared.added[0].name, 'guide.md')
  assert.equal(prepared.added[1].name, 'example.com', 'a bare host is named after itself')
  assert.deepEqual(prepared.skipped, ['https://example.com/docs/guide.md'], 'a repeated link is a duplicate')
})

test('without a project root the stored values are absolute paths', async () => {
  const dir = await tempDir()
  await makeFile(dir, 'a.md')
  const prepared = await prepareIntake(boardWithRoot(''), [join(dir, 'a.md')])
  assert.deepEqual(prepared.added.map(entry => entry.value), [join(dir, 'a.md')])
})

test('preparing twice keeps the scan stable, and an unscanned op is refused', async () => {
  const dir = await tempDir()
  await makeFile(dir, 'a.md')
  const board = boardWithRoot(dir)
  const first = await prepareIntake(board, [dir])
  const second = (await prepareBatch(board, [first]))[0]
  assert.deepEqual(second.added, first.added, 'an already scanned op is not scanned again')

  // A raw operation that never went through prepare has no ledger to write.
  const outcome = applyOps(board, [{ type: 'reference.intake', projectId: 'p', paths: [dir] }])
  assert.equal(outcome.rejected.length, 1)
  assert.equal(outcome.rejected[0].code, 'invalid_field')
  assert.equal(outcome.board.projects[0].references.length, 0)

  // An operation with no usable path is refused too.
  const empty = await prepareIntake(board, [])
  assert.equal(empty.added, undefined)
  const refusing = applyOps(board, [{ type: 'reference.intake', projectId: 'p', paths: ['   '] }])
  assert.equal(refusing.rejected[0].code, 'invalid_field')
})