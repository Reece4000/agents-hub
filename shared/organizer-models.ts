export type OrganizerProvider = 'codex' | 'claude'
export interface OrganizerConfig { provider: OrganizerProvider; model: string; enabled: boolean }
export interface OrganizerModel { id: string; label: string; detail: string }

export const organizerModels: Record<OrganizerProvider, readonly OrganizerModel[]> = {
  codex: [
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', detail: 'Fast (recommended)' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol', detail: 'More capable' },
  ],
  claude: [
    { id: 'haiku', label: 'Claude Haiku', detail: 'Fast (recommended)' },
    { id: 'sonnet', label: 'Claude Sonnet', detail: 'More capable' },
  ],
}

export const preferredOrganizerModel = (provider: OrganizerProvider) => organizerModels[provider][0].id
