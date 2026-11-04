import { choice, noul } from '@typesafe-ai/sdk';

export const MATCH_THRESHOLD = 0.7;
export const CHOICE_THRESHOLD = 0.7;
export const DEFAULT_JEV_MODEL = 'jev-1.14.0';

export function buildTargetQuestions(description, elements) {
  const ids = new Map();
  const criteria = {};
  const candidates = {};
  elements.forEach((element, index) => {
    const name = `${element.role}_${element.label}`.normalize('NFKD').replace(/[^\p{L}\p{N}_]+/gu, '_').slice(0, 64) + `_${index}`;
    ids.set(name, element.id);
    criteria[name] = null;
    candidates[name] = { role: element.role, label: element.label, section: element.section ?? '', inViewport: element.inViewport };
  });
  return {
    ids,
    state: { targetDescription: description, candidates },
    questions: {
      target: choice('Which candidate in candidates matches the control described in targetDescription?', criteria),
      exists: noul('Does any candidate match the control described in targetDescription?', {
        true: 'At least one candidate represents the described control.',
        false: 'The described control is absent from the candidates.',
      }),
    },
  };
}

export function readTargetAnswer(answers, ids) {
  const exists = answers?.exists?.noul;
  const selected = answers?.target?.choice;
  const probability = answers?.target?.probabilities?.[selected];
  if (typeof exists !== 'number' || !Number.isFinite(exists) || exists < 0 || exists > 1 || !ids.has(selected) || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error('Jev returned an invalid target answer.');
  }
  if (exists <= 0.3) return { status: 'missing' };
  if (exists < MATCH_THRESHOLD || probability < CHOICE_THRESHOLD) return { status: 'uncertain' };
  return { status: 'selected', targetId: ids.get(selected) };
}
