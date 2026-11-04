import type { SemanticElement } from '../registry/element-registry';
import type { GuideAction } from '../reasoning/reasoning';

export const REDACTED_VALUE = '[redacted]';

// Match code syntax, not ordinary UI text such as "function header" or "let me".
export function containsExecutableText(value: string): boolean {
  return /<\/?script\b|javascript:|```|=>|\bfunction\s*\*?\s*(?:[\w$]+\s*)?\(|\b(?:const|let|var)\s+(?:[\w$]+\s*[=;,]|[\[{])/i.test(value);
}

export type ConsequenceType =
  | 'submission'
  | 'consent'
  | 'financial'
  | 'identity'
  | 'personal-data'
  | 'credentials';

export type SafetyTarget = Pick<
  SemanticElement,
  'id' | 'role' | 'label' | 'disabled'
>;

export type SafetyDecision =
  | {
      allowed: true;
      requiresExplicitUserAction: boolean;
      consequence?: ConsequenceType;
    }
  | {
      allowed: false;
      code: 'missing-target' | 'disabled-target';
      reason: string;
    };

const SENSITIVE_LABEL_PATTERN =
  /\b(?:aadhaar|aadhar|uan|account|bank|ifsc|otp|one[- ]time password|password|passcode|pin|phone|mobile|address|dob|date of birth)\b/i;

const CONSEQUENCE_RULES: Array<{
  type: ConsequenceType;
  pattern: RegExp;
}> = [
  {
    type: 'submission',
    pattern: /\b(?:submit|file|send|finalize|publish|delete|remove|erase)\b/i,
  },
  {
    type: 'consent',
    pattern: /\b(?:consent|agree|accept|authorize|approve|declaration)\b/i,
  },
  {
    type: 'identity',
    pattern: /\b(?:aadhaar|aadhar|otp|kyc|identity|verify|verification)\b/i,
  },
  {
    type: 'personal-data',
    pattern: /\b(?:change|update|edit|modify)\b.*\b(?:name|phone|mobile|address|bank|email|profile)\b/i,
  },
  {
    type: 'financial',
    pattern: /\b(?:withdraw|transfer|payment|payout|bank|money|purchase|buy|checkout|pay)\b/i,
  },
  {
    type: 'credentials',
    pattern: /\b(?:password|passcode|pin|secret)\b/i,
  },
];

function redactMatches(value: string, pattern: RegExp): string {
  return value.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED_VALUE}`);
}

export function isSensitiveLabel(label: string): boolean {
  return SENSITIVE_LABEL_PATTERN.test(label);
}

export function redactSensitiveText(value: string): string {
  let redacted = value;

  redacted = redacted.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    REDACTED_VALUE,
  );
  redacted = redacted.replace(
    /\b(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g,
    REDACTED_VALUE,
  );
  redacted = redacted.replace(/\b\d{10,18}\b/g, REDACTED_VALUE);
  redacted = redactMatches(
    redacted,
    /(\b(?:otp|one[- ]time password|pin)\b[^.!?\n]{0,24}?)(\b\d{4,8}\b)/gi,
  );
  redacted = redactMatches(
    redacted,
    /(\bifsc\b[^.!?\n]{0,24}?)(\b[A-Z]{4}0[A-Z0-9]{6}\b)/gi,
  );
  redacted = redactMatches(
    redacted,
    /(\b(?:password|passcode|secret)\b\s*(?:is|:|-)?\s*)([^\s,.!?]+)/gi,
  );

  return redacted;
}

export function classifyConsequence(label: string): ConsequenceType | undefined {
  return CONSEQUENCE_RULES.find((rule) => rule.pattern.test(label))?.type;
}

export function evaluateGuideActionSafety(
  action: GuideAction,
  targets: Iterable<SafetyTarget>,
): SafetyDecision {
  if (!('targetId' in action)) {
    return {
      allowed: true,
      requiresExplicitUserAction: false,
    };
  }

  const target = Array.from(targets).find((candidate) => candidate.id === action.targetId);
  if (!target) {
    return {
      allowed: false,
      code: 'missing-target',
      reason: `Target ${action.targetId} is not present in the live safety registry.`,
    };
  }

  if (action.action === 'guide' && target.disabled) {
    return {
      allowed: false,
      code: 'disabled-target',
      reason: `Target ${action.targetId} is disabled and cannot be offered for user action.`,
    };
  }

  return {
    allowed: true,
    requiresExplicitUserAction: action.action === 'guide',
    ...(classifyConsequence(target.label)
      ? { consequence: classifyConsequence(target.label) }
      : {}),
  };
}
