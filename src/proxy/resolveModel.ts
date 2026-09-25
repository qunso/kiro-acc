/**
 * Unified Admin Model Rewrite for every account type and request path.
 *
 * Applies the same rules Kiro translate used historically: custom model-map
 * (data/model-map.json via setCustomModelMap) layered on builtin mapModelId.
 *
 * Call exactly once after parsing the request body. Use the result for:
 *   1) accountSupportsModel / pool filter
 *   2) compat upstream forward body (then modelPrefix)
 *   3) Kiro translate (pass already-resolved model; do not map again)
 *   4) usage / request-log model fields
 */
import { mapModelId } from '../kiro/translator.js'

export function resolveRequestModel(clientModel: string | undefined | null): string {
  return mapModelId(String(clientModel ?? ''))
}
