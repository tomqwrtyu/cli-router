export type BillingCap = {
  unit: 'credits_per_1m_tokens'
  input: number
  output: number
  costMultiplier: number
  referenceModel?: string
}

type Billing = Record<string, unknown>

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function parseBillingCap(raw: string | undefined): BillingCap | null {
  if (!raw) return null
  const value = JSON.parse(raw)
  if (
    !value ||
    typeof value !== 'object' ||
    value.unit !== 'credits_per_1m_tokens' ||
    !nonNegativeNumber(value.input) ||
    !nonNegativeNumber(value.output) ||
    !nonNegativeNumber(value.costMultiplier) ||
    (value.referenceModel !== undefined && typeof value.referenceModel !== 'string')
  ) {
    throw new Error('ROUTER_BILLING_CAP_JSON is invalid')
  }
  return value as BillingCap
}

export function applyBillingCap(
  billing: Billing | null | undefined,
  cap: BillingCap | null,
): Billing | null | undefined {
  if (!cap || !billing || billing.unit !== 'credits_per_1m_tokens') return billing
  if (
    !nonNegativeNumber(billing.input) ||
    !nonNegativeNumber(billing.output) ||
    !nonNegativeNumber(billing.costMultiplier)
  ) {
    return billing
  }

  return {
    ...billing,
    input: Math.min(billing.input, cap.input),
    output: Math.min(billing.output, cap.output),
    costMultiplier: Math.min(billing.costMultiplier, cap.costMultiplier),
    pricingPolicy: 'client_price_ceiling',
    ...(cap.referenceModel ? { priceCeilingModel: cap.referenceModel } : {}),
  }
}
