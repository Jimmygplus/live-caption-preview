export const CAPTION_STATES = Object.freeze({
  DRAFT: 'draft',
  FINAL: 'final',
  CORRECTED: 'corrected',
});

export function draftView({ finalOrig = '', interimOrig = '', finalTrans = '', interimTrans = '' } = {}) {
  return {
    state: CAPTION_STATES.DRAFT,
    original: { stable: finalOrig, changing: interimOrig },
    translation: { stable: finalTrans, changing: interimTrans },
  };
}

export function createFinalCaption(fields = {}) {
  return {
    ...fields,
    state: CAPTION_STATES.FINAL,
    revision: 1,
  };
}

export function isNewerCaptionRevision(currentRevision, incomingRevision) {
  return Number.isSafeInteger(incomingRevision)
    && incomingRevision > 0
    && (!Number.isSafeInteger(currentRevision) || incomingRevision > currentRevision);
}

export function applyCaptionPatch(caption, patch, {
  expectedRevision = caption.revision,
  state = caption.state,
} = {}) {
  if (caption.revision !== expectedRevision) {
    return { applied: false, reason: 'stale', caption };
  }

  const next = {
    ...caption,
    ...patch,
    state,
    revision: caption.revision + 1,
  };
  if (next.orig === caption.orig && next.trans === caption.trans && next.state === caption.state) {
    return { applied: false, reason: 'unchanged', caption };
  }
  return { applied: true, caption: next };
}
