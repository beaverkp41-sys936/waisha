export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
    public details: unknown[] = []
  ) {
    super(message);
  }
}