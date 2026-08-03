import { isApplicationMaintenance } from './maintenance.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test('maintenance requires an explicit true secret', () => {
  assert(isApplicationMaintenance({ get: () => 'true' }), 'true must close admission')
  assert(!isApplicationMaintenance({ get: () => 'false' }), 'false must leave admission open')
  assert(!isApplicationMaintenance({ get: () => undefined }), 'missing secret must leave admission open')
})
