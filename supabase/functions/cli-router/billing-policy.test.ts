import { applyBillingCap, parseBillingCap } from './billing-policy.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const cap = parseBillingCap(JSON.stringify({
  unit: 'credits_per_1m_tokens',
  input: 2,
  output: 12,
  costMultiplier: 2,
  referenceModel: 'gemini-3.1-pro-preview',
}))

Deno.test('caps expensive client billing at Gemini Pro rates', () => {
  const billing = applyBillingCap({
    unit: 'credits_per_1m_tokens',
    input: 5,
    output: 30,
    costMultiplier: 2,
    estimatedUsage: true,
  }, cap)
  assert(billing?.input === 2, 'input rate was not capped')
  assert(billing?.output === 12, 'output rate was not capped')
  assert(billing?.costMultiplier === 2, 'multiplier changed unexpectedly')
  assert(billing?.priceCeilingModel === 'gemini-3.1-pro-preview', 'reference model is missing')
})

Deno.test('preserves models already cheaper than the client ceiling', () => {
  const billing = applyBillingCap({
    unit: 'credits_per_1m_tokens',
    input: 1,
    output: 6,
    costMultiplier: 2,
  }, cap)
  assert(billing?.input === 1, 'lower input rate was increased')
  assert(billing?.output === 6, 'lower output rate was increased')
})

Deno.test('leaves provider billing unchanged when no client cap is configured', () => {
  const source = { unit: 'credits_per_1m_tokens', input: 5, output: 30, costMultiplier: 2 }
  assert(applyBillingCap(source, null) === source, 'unconfigured policy changed billing')
})
