export class HttpError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}
