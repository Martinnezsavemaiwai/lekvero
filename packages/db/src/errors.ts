export class LekveroDbError extends Error {
  override readonly name: string = 'LekveroDbError';
}
export class PayloadTooLargeError extends LekveroDbError {
  override readonly name = 'PayloadTooLargeError';
}
export class SensitiveDataError extends LekveroDbError {
  override readonly name = 'SensitiveDataError';
}
export class UnstorableResultError extends LekveroDbError {
  override readonly name = 'UnstorableResultError';
}
export class NotFoundError extends LekveroDbError {
  override readonly name = 'NotFoundError';
}
export class EnvironmentNotAllowedError extends LekveroDbError {
  override readonly name = 'EnvironmentNotAllowedError';
}
