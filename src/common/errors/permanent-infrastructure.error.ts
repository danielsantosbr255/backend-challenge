import { ApplicationError } from './application.error';

export class PermanentInfrastructureError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super('PERMANENT_INFRASTRUCTURE_FAILURE', 'A permanent infrastructure failure occurred', options);
    this.name = 'PermanentInfrastructureError';
  }
}
