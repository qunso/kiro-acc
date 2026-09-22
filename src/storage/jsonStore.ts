import fs from 'node:fs/promises'
import path from 'node:path'

export class JsonStore<T> {
  constructor(
    private readonly filePath: string,
    private readonly defaultValue: T,
  ) {}

  async ensure(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      await fs.access(this.filePath)
    } catch {
      await this.write(this.defaultValue)
    }
  }

  async read(): Promise<T> {
    await this.ensure()
    const raw = await fs.readFile(this.filePath, 'utf8')
    try {
      return JSON.parse(raw) as T
    } catch {
      return structuredClone(this.defaultValue)
    }
  }

  async write(data: T): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }

  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    const current = await this.read()
    const next = await mutator(current)
    await this.write(next)
    return next
  }
}
