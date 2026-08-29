import { useTranslation } from 'react-i18next'
import type { EnvCheck, EnvironmentReport } from '../../global'
import { checkLabelKey, fixHintKey, summarizeReport } from '../../utils/environmentCheck'

interface Props {
  report:  EnvironmentReport | null
  loading: boolean
  error:   string | null
  onRerun: () => void
}

const ICONS: Record<EnvCheck['status'], string> = { ok: '✔', warn: '⚠', fail: '✘' }

/**
 * Pre-flight environment self-check (Ticket T3).
 *
 * Users reporting "it just doesn't work" were almost always looking at an
 * environment problem — no torch wheel, a full disk, an antivirus-mangled
 * install — that only surfaced as a failure minutes into a run. This renders
 * the engine's own checklist up front: one row per probe, the failing ones
 * expanded with what to do about them, and the training button gated on it.
 */
export function EnvironmentCheck({ report, loading, error, onRerun }: Props): JSX.Element {
  const { t } = useTranslation()
  const { canTrain, failures, warnings } = summarizeReport(report)

  const headline = loading
    ? t('envCheck.running')
    : error       ? t('envCheck.errored')
    : !report     ? t('envCheck.idle')
    : canTrain    ? (warnings.length > 0 ? t('envCheck.passedWithWarnings', { count: warnings.length }) : t('envCheck.passed'))
    : t('envCheck.failed', { count: failures.length })

  return (
    <div className={`env-check${!loading && report && !canTrain ? ' env-check-blocked' : ''}`}>
      <div className="env-check-head">
        <span className="env-check-headline">
          {loading && <span className="at-spinner" aria-hidden="true" />}
          {headline}
        </span>
        <button type="button" className="btn btn-ghost env-check-rerun" onClick={onRerun} disabled={loading}>
          {t('envCheck.rerun')}
        </button>
      </div>

      {error && <div className="result-box err">{error}</div>}

      {report && (
        <>
          <ul className="env-check-list">
            {report.checks.map((check) => {
              const hintKey = check.status === 'ok' ? null : fixHintKey(check)
              return (
                <li key={check.id} className={`env-check-row env-${check.status}`}>
                  <span className="env-check-icon" aria-hidden="true">{ICONS[check.status]}</span>
                  <div className="env-check-body">
                    <span className="env-check-label">
                      {t(checkLabelKey(check), {
                        defaultValue: check.label,
                        name: check.id.replace(/^package\./, ''),
                      })}
                    </span>
                    <span className="env-check-detail">{check.detail}</span>
                    {check.status !== 'ok' && (check.fix || hintKey) && (
                      <span className="env-check-fix">
                        {/* The engine's own `fix` is the exact command where
                            there is one (a pip install line); the localized
                            hint explains the rest. */}
                        {check.fix && <code className="env-check-cmd">{check.fix}</code>}
                        {hintKey && <span>{t(hintKey, { defaultValue: '' })}</span>}
                      </span>
                    )}
                  </div>
                  <span className="sr-only">{t(`envCheck.status.${check.status}`)}</span>
                </li>
              )
            })}
          </ul>

          <div className="env-check-meta">
            {report.python && <span>{t('envCheck.pythonVersion', { version: report.python })}</span>}
            <span>{report.platform}</span>
          </div>

          {report.missing.length > 0 && (
            <div className="env-check-install">
              <span>{t('envCheck.installMissing')}</span>
              <code className="env-check-cmd">pip install {report.missing.join(' ')}</code>
            </div>
          )}
        </>
      )}
    </div>
  )
}
