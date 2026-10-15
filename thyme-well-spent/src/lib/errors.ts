/** Errors whose message is safe to show to the user. Anything else is hidden behind a generic message. */
export class AppError extends Error {
  constructor(message: string, public status = 400, public code = "bad_request") {
    super(message);
  }
}
export const notFound = (what = "That") => new AppError(`${what} couldn't be found.`, 404, "not_found");
export const forbidden = () => new AppError("You don't have access to that.", 403, "forbidden");
export const unauthorized = () => new AppError("Please sign in to continue.", 401, "unauthorized");
export const proRequired = (feature: string) => new AppError(`${feature} is part of Thyme Pro.`, 402, "pro_required");
