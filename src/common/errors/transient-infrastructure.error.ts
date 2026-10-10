import { ApplicationError } from './application.error';

export class TransientInfrastructureError extends ApplicationError {
  constructor() {
    super('TRANSIENT_INFRASTRUCTURE_FAILURE', 'A temporary infrastructure failure occurred');
    this.name = 'TransientInfrastructureError';
  }
}
