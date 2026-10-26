/** Shared, validated Typert wire descriptors; no Client runtime dependencies. */
export function codec(typeSymbol, jsonSchema, validate) {
  const parse = value => {
    if (!validate(value)) throw new TypeError(`Invalid ${typeSymbol}`);
    return value;
  };
  return { mode: 'strict', typeSymbol, jsonSchema, create: () => ({ parse,
    safeParse(value) { try { return { success: true, data: parse(value) }; }
      catch (error) { return { success: false, error }; } } }) };
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = value => Object.keys(value);
const isText = value => typeof value === 'string';
const isSeq = value => Number.isSafeInteger(value) && value >= 0;
const STATUSES = ['ready', 'unavailable', 'stale', 'error'];
const REASONS = ['none', 'no-model', 'model-unavailable', 'skill-unavailable',
  'invalid-output', 'limit', 'timeout', 'provider-error', 'empty', 'stale'];

export const requestCodec = codec('PromptAssistRequest', {
  type: 'object', properties: { sessionId: { type: 'string', minLength: 1 }, endSeq: { type: 'integer', minimum: 0 } },
  required: ['sessionId', 'endSeq'], additionalProperties: false,
}, v => object(v) && keys(v).length === 2 && isText(v.sessionId) && v.sessionId.length > 0 && isSeq(v.endSeq));

export const resultCodec = codec('PromptAssistResult', {
  type: 'object', properties: { text: { type: 'string' }, status: { enum: ['ready', 'unavailable', 'stale', 'error'] } },
  required: ['text', 'status'], additionalProperties: false,
}, v => object(v) && keys(v).length === 2 && isText(v.text) && STATUSES.includes(v.status));

export const continueRequestCodec = codec('PromptAssistContinueRequest', {
  type: 'object', properties: {
    sessionId: { type: 'string', minLength: 1 }, endSeq: { type: 'integer', minimum: 0 },
    prefix: { type: 'string' }, suffix: { type: 'string' },
  },
  required: ['sessionId', 'endSeq', 'prefix', 'suffix'], additionalProperties: false,
}, v => object(v) && keys(v).length === 4 && isText(v.sessionId) && v.sessionId.length > 0 && isSeq(v.endSeq)
  && isText(v.prefix) && isText(v.suffix) && v.prefix.length + v.suffix.length <= 8000);

const reasonSchema = { enum: REASONS };
const textResultSchema = {
  type: 'object', properties: { status: { enum: STATUSES }, reason: reasonSchema, text: { type: 'string' } },
  required: ['status', 'reason', 'text'], additionalProperties: false,
};
export const continueResultCodec = codec('PromptAssistContinueResult', textResultSchema,
  v => object(v) && keys(v).length === 3 && STATUSES.includes(v.status) && REASONS.includes(v.reason) && isText(v.text));

export const optimizeRequestCodec = codec('PromptAssistOptimizeRequest', {
  type: 'object', properties: {
    sessionId: { type: 'string', minLength: 1 }, endSeq: { type: 'integer', minimum: 0 },
    text: { type: 'string', minLength: 1 }, before: { type: 'string' }, after: { type: 'string' },
  },
  required: ['sessionId', 'endSeq', 'text', 'before', 'after'], additionalProperties: false,
}, v => object(v) && keys(v).length === 5 && isText(v.sessionId) && v.sessionId.length > 0 && isSeq(v.endSeq)
  && isText(v.text) && v.text.length >= 1 && v.text.length <= 6000
  && isText(v.before) && isText(v.after) && v.before.length <= 800 && v.after.length <= 800);

export const optimizeResultCodec = codec('PromptAssistOptimizeResult', {
  type: 'object', properties: {
    status: { enum: STATUSES }, reason: reasonSchema, mode: { enum: ['', 'replace', 'questions'] }, text: { type: 'string' },
  },
  required: ['status', 'reason', 'mode', 'text'], additionalProperties: false,
}, v => object(v) && keys(v).length === 4 && STATUSES.includes(v.status) && REASONS.includes(v.reason)
  && ['', 'replace', 'questions'].includes(v.mode) && isText(v.text));

export const modelsRequestCodec = codec('PromptAssistModelsRequest', {
  type: 'object', properties: {}, required: [], additionalProperties: false,
}, v => object(v) && keys(v).length === 0);

export const modelsResultCodec = codec('PromptAssistModelsResult', {
  type: 'object', properties: {
    status: { enum: STATUSES }, reason: reasonSchema,
    providers: {
      type: 'array',
      items: {
        type: 'object', properties: {
          id: { type: 'string' }, name: { type: 'string' },
          models: {
            type: 'array',
            items: {
              type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } },
              required: ['id', 'name', 'description'], additionalProperties: false,
            },
          },
        },
        required: ['id', 'name', 'models'], additionalProperties: false,
      },
    },
  },
  required: ['status', 'reason', 'providers'], additionalProperties: false,
}, v => object(v) && keys(v).length === 3 && STATUSES.includes(v.status) && REASONS.includes(v.reason)
  && Array.isArray(v.providers) && v.providers.every(p => object(p) && keys(p).length === 3
    && isText(p.id) && isText(p.name) && Array.isArray(p.models) && p.models.every(m => object(m) && keys(m).length === 3
      && isText(m.id) && isText(m.name) && isText(m.description))));

export const descriptor = {
  id: '@catwithoutear/dsh-prompt-assist#localPromptAssist/predict',
  service: 'localPromptAssist', namespace: 'localPromptAssist', method: 'predict',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: requestCodec }],
  cancellation: { parameter: 'signal' }, result: resultCodec,
  description: 'Generate one next-user-message preview for the exact completed turn; never sends a user message.',
};
export const continueDescriptor = {
  id: '@catwithoutear/dsh-prompt-assist#localPromptAssist/continueDraft',
  service: 'localPromptAssist', namespace: 'localPromptAssist', method: 'continueDraft',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'continueRequest', source: 'json', codec: continueRequestCodec }],
  cancellation: { parameter: 'signal' }, result: continueResultCodec,
  description: 'Generate one continuation after the current draft prefix; never applies or sends it.',
};
export const optimizeDescriptor = {
  id: '@catwithoutear/dsh-prompt-assist#localPromptAssist/optimize',
  service: 'localPromptAssist', namespace: 'localPromptAssist', method: 'optimize',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'optimizeRequest', source: 'json', codec: optimizeRequestCodec }],
  cancellation: { parameter: 'signal' }, result: optimizeResultCodec,
  description: 'Clarify and optimize one selected draft instruction through the /clarify skill; never applies it.',
};
export const modelsDescriptor = {
  id: '@catwithoutear/dsh-prompt-assist#localPromptAssist/listModels',
  service: 'localPromptAssist', namespace: 'localPromptAssist', method: 'listModels',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'modelsRequest', source: 'json', codec: modelsRequestCodec }],
  cancellation: { parameter: 'signal' }, result: modelsResultCodec,
  description: 'List the configured provider/model routes that the auxiliary model setting can select.',
};
export const remoteContribution = {
  package: '@catwithoutear/dsh-prompt-assist',
  descriptors: [descriptor, continueDescriptor, optimizeDescriptor, modelsDescriptor],
};
