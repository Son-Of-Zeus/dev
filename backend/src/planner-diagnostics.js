import { publicModelFailure, ModelFailure } from './reasoning-errors.js';

// Explicitly enabled server diagnostics. Never log requests, SSE envelopes,
// provider reasoning, unknown fields, or unparsed response text.
const TEXT_FIELDS = new Set(['targetDescription', 'spokenInstruction', 'consequence', 'precondition', 'expectedOutcome', 'intent', 'clarifyingQuestion']);
const ENUMS = {
  action: ['guide', 'explain', 'scroll', 'wait', 'clarify', 'success'],
  language: ['en-IN', 'hi-IN'],
  readiness: ['ready', 'needs_clarification', 'not_applicable'],
};

function redact(value) {
  return value
    .replace(/https?:\/\/[^\s"<>]+/gi, '[redacted URL]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{24,}\b/g, '[redacted token]')
    .replace(/\b(?:\+?\d[\d ()-]{7,}\d)\b/g, '[redacted number]')
    .replace(/\b(?:password|passcode|secret|api[_ -]?key|otp|pin)\s*(?:is|:|=|-)\s*[^\s,.;]+/gi, '[redacted credential]')
    .replace(/<[^>]*>/g, '[redacted markup]')
    .slice(0, 2500);
}

export function summarizePlanResponse(value, depth = 0) {
  if (depth > 4) return '[depth limit]';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value };
  const output = {};
  for (const [key, entry] of Object.entries(value).slice(0, 16)) {
    if (['decision', 'workflow'].includes(key)) output[key] = summarizePlanResponse(entry, depth + 1);
    else if (key === 'sequence') output[key] = Number.isInteger(entry) && entry >= 1 && entry <= 3 ? entry : '[invalid sequence]';
    else if (ENUMS[key]) output[key] = ENUMS[key].includes(entry) ? entry : '[invalid enum]';
    else if (TEXT_FIELDS.has(key)) output[key] = typeof entry === 'string' ? { text: redact(entry), length: entry.length } : { type: entry === null ? 'null' : Array.isArray(entry) ? 'array' : typeof entry };
    else if (['requiredInformation', 'knownInformation', 'missingInformation'].includes(key)) output[key] = Array.isArray(entry) ? { count: entry.length, itemTypes: [...new Set(entry.map((item) => typeof item))].slice(0, 8) } : { type: typeof entry };
    else output.omittedFields = (output.omittedFields ?? 0) + 1;
  }
  return output;
}

export function reportRejectedPlan(value, error, { attempt, committed, onRejectedPlan } = {}) {
  const details = { event: 'muse-plan-rejected', attempt, committed,
    failure: publicModelFailure(new ModelFailure('PLANNER_INVALID_RESPONSE', 'Muse', error)),
    response: value === undefined ? { parsed: false } : summarizePlanResponse(value) };
  (onRejectedPlan ?? ((report) => console.warn('[Voice Companion Muse diagnostic]', JSON.stringify(report))))(details);
}
