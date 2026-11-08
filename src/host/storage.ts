import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

export const DATA_DIR = join(DSH_HOME, 'storages', 'video-kit')
export const VIDEO_DIR = join(DATA_DIR, 'videos')
export const THUMB_DIR = join(DATA_DIR, 'thumbnails')
export const JOBS_FILE = join(DATA_DIR, 'jobs.json')
export const CONFIG_FILE = join(DATA_DIR, 'config.json')
export const IGNORED_IMPORTS_FILE = join(DATA_DIR, 'ignored-imports.json')

export async function ensureDirs(): Promise<void> {
  await mkdir(VIDEO_DIR, { recursive: true })
  await mkdir(THUMB_DIR, { recursive: true })
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  }
  catch {
    return fallback
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(tmp, file)
}
