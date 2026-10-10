import { ApplicationError } from './application.error';

export class TransientInfrastructureError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super('TRANSIENT_INFRASTRUCTURE_FAILURE', 'A temporary infrastructure failure occurred', options);
    this.name = 'TransientInfrastructureError';
  }
}
