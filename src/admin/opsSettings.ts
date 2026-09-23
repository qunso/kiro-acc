import path from 'node:path'
import { JsonStore } from '../storage/jsonStore.js'

export interface UiPrefs {
  /** Default landing tab id */
  defaultTab?: string
}

export interface OpsSettings {
  /** In-memory request log ring buffer capacity */
  requestLogCapacity?: number
  uiPrefs?: UiPrefs
}

const DEFAULTS: Required<OpsSettings> = {
  requestLogCapacity: 500,
  uiPrefs: {},
}

export class OpsSettingsStore {
  private file: JsonStore<OpsSettings>
  private data: OpsSettings = { ...DEFAULTS }

  constructor(dataDir: string) {
    this.file = new JsonStore(path.join(dataDir, 'ops-settings.json'), { ...DEFAULTS })
  }

  async init(): Promise<void> {
    const raw = await this.file.read()
    this.data = {
      requestLogCapacity:
        raw.requestLogCapacity != null && Number.isFinite(Number(raw.requestLogCapacity))
          ? Math.max(50, Math.min(5000, Math.floor(Number(raw.requestLogCapacity))))
          : DEFAULTS.requestLogCapacity,
      uiPrefs: raw.uiPrefs && typeof raw.uiPrefs === 'object' ? { ...raw.uiPrefs } : {},
    }
  }

  get(): OpsSettings {
    return {
      requestLogCapacity: this.data.requestLogCapacity ?? DEFAULTS.requestLogCapacity,
      uiPrefs: { ...(this.data.uiPrefs || {}) },
    }
  }

  async patch(patch: OpsSettings): Promise<OpsSettings> {
    if (patch.requestLogCapacity != null) {
      this.data.requestLogCapacity = Math.max(
        50,
        Math.min(5000, Math.floor(Number(patch.requestLogCapacity))),
      )
    }
    if (patch.uiPrefs) {
      this.data.uiPrefs = { ...(this.data.uiPrefs || {}), ...patch.uiPrefs }
    }
    await this.file.write(this.data)
    return this.get()
  }
}
