export type EnvironmentReader = { get(name: string): string | undefined }

export function isApplicationMaintenance(
  environment: EnvironmentReader = Deno.env,
): boolean {
  return environment.get('APP_MAINTENANCE_MODE') === 'true'
}

export function maintenanceResponse(cors: HeadersInit): Response {
  return new Response(JSON.stringify({
    error: 'Application maintenance in progress',
    code: 'APP_MAINTENANCE',
  }), {
    status: 503,
    headers: {
      ...cors,
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'retry-after': '15',
    },
  })
}
