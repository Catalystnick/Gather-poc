export class TenantServiceError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'TenantServiceError'
    // HTTP status + machine-readable code keep API error handling consistent.
    this.status = Number.isInteger(options.status) ? options.status : 500
    this.code = typeof options.code === 'string' ? options.code : 'tenant_service_error'
    this.details = options.details ?? null
  }
}
