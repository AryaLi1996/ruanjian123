// Maps the internal stem identifiers returned by the Python separation
// engine (see engine/separation.py's `stems` dict keys) to i18next
// translation keys under the `tracks.*` namespace. Track lists should
// always render `t(stemLabelKey(rawKey))` instead of the raw identifier so
// stem names re-localize instantly when the app language changes
// (Ticket 46).
const STEM_KEY_TO_I18N: Record<string, string> = {
  vocals:        'tracks.vocal',
  // Enhanced-mode's dereverbed lead vocal — displayed the same as a plain
  // vocal stem since the two never appear together (standard mode yields
  // `vocals`, enhanced mode yields `lead_dry` + `harmony_dry`).
  lead_dry:      'tracks.vocal',
  accompaniment: 'tracks.accompaniment',
  harmony_dry:   'tracks.harmony',
}

export function stemLabelKey(stemKey: string): string {
  return STEM_KEY_TO_I18N[stemKey] ?? 'tracks.other'
}
