import { describe, expect, it } from 'vitest'
import i18n, { SUPPORTED_LANGUAGES } from '../i18n'

/**
 * Every string the training-quality surfaces render, in every language the
 * app ships.
 *
 * A missing key here doesn't throw — i18next renders the key path itself, so
 * a quality report with an untranslated finding would ship looking like
 * "quality.issue.snr" in the one place the user most needs a sentence they
 * can act on. The bundles are hand-maintained object literals; this is what
 * keeps them the same shape.
 */
const REQUIRED_KEYS = [
  'training.shortDataTitle', 'training.shortDataMessage', 'training.shortDataConfirm',
  'training.rawResult',
  'quality.title', 'quality.scoreLabel', 'quality.scoreValue', 'quality.scoreUnknown',
  'quality.level.good', 'quality.level.fair', 'quality.level.poor',
  'quality.clean', 'quality.issuesTitle', 'quality.tipsTitle',
  'quality.issue.noData', 'quality.issue.duration', 'quality.issue.snr', 'quality.issue.similarity',
  'quality.tip.noData', 'quality.tip.duration', 'quality.tip.snr', 'quality.tip.similarity',
  'quality.openDenoise', 'quality.retrain', 'quality.keep', 'quality.reopen', 'quality.savedNote',
]

describe('training quality translations', () => {
  for (const language of SUPPORTED_LANGUAGES) {
    describe(language, () => {
      it('defines every quality-report and pre-flight string', () => {
        const t = i18n.getFixedT(language)
        for (const key of REQUIRED_KEYS) {
          expect(i18n.exists(key, { lng: language }), `${key} missing in ${language}`).toBe(true)
          expect(String(t(key)).trim().length, `${key} empty in ${language}`).toBeGreaterThan(0)
        }
      })

      it('interpolates the numbers each message promises', () => {
        const t = i18n.getFixedT(language)
        expect(t('quality.issue.duration', { minutes: 0.6, seconds: 34, recommended: 15 }))
          .toContain('34')
        expect(t('quality.issue.snr', { snr: 8.4, required: 15 })).toContain('8.4')
        expect(t('training.shortDataMessage', { seconds: 43, minutes: 15, mode: 'x' }))
          .toContain('43')
      })
    })
  }
})
