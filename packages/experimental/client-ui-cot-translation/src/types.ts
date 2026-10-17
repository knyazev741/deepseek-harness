/** Browser-safe translation preferences and Remote metadata. */
import type {} from '@knyazevai/dsh-typert-protocol'
import type { TranslationProvider } from '@knyazevai/dsh-experimental-translator/types'

/** Translation choices; auto targets the active browser UI language. */
export interface CotTranslationPreferences {
  /** Explicit provider selection; requests never fall back to another provider. */
  provider: TranslationProvider
  /** BCP 47 language code, or auto to follow the UI language. */
  targetLanguage: string
}

/** Authoritative Host metadata read before any reasoning is submitted. */
export interface CotTranslationSnapshot {
  /** Maximum UTF-16 text length accepted by one translation request. */
  maxTextChars: number
  /** Current accepted provider and target-language preferences. */
  preferences: CotTranslationPreferences
  /** Anonymous endpoints and native paid routes currently eligible for translation. */
  availableProviders: readonly TranslationProvider[]
}

declare module '@knyazevai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Provider or input failure, without original text or response details. */
    'cotTranslation/failed': Record<string, never>
  }
}
