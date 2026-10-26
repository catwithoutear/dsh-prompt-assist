/** Shared, validated Typert wire descriptor; no Client runtime dependencies. */
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
export const requestCodec = codec('PromptAssistRequest', {
  type: 'object', properties: { sessionId: { type: 'string', minLength: 1 }, endSeq: { type: 'integer', minimum: 0 } },
  required: ['sessionId', 'endSeq'], additionalProperties: false,
}, v => object(v) && Object.keys(v).length === 2 && typeof v.sessionId === 'string' && v.sessionId.length > 0
  && Number.isSafeInteger(v.endSeq) && v.endSeq >= 0);
export const resultCodec = codec('PromptAssistResult', {
  type: 'object', properties: { text: { type: 'string' }, status: { enum: ['ready', 'unavailable', 'stale', 'error'] } },
  required: ['text', 'status'], additionalProperties: false,
}, v => object(v) && Object.keys(v).length === 2 && typeof v.text === 'string'
  && ['ready', 'unavailable', 'stale', 'error'].includes(v.status));
export const descriptor = {
  id: '@catwithoutear/dsh-prompt-assist#localPromptAssist/predict',
  service: 'localPromptAssist', namespace: 'localPromptAssist', method: 'predict',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: requestCodec }],
  cancellation: { parameter: 'signal' }, result: resultCodec,
  description: 'Generate one next-user-message preview for the exact completed turn; never sends a user message.',
};
export const remoteContribution = { package: '@catwithoutear/dsh-prompt-assist', descriptors: [descriptor] };
