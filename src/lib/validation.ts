/**
 * Server-side validation utilities for Movie Memory.
 * Enforces trimming, min/max character boundaries, and sanitization.
 */

export const MOVIE_TITLE_MIN_LENGTH = 1;
export const MOVIE_TITLE_MAX_LENGTH = 120;

export interface MovieValidationResult {
  valid: boolean;
  movie?: string;
  error?: string;
}

/**
 * Validates and normalizes a user-submitted movie title on the server.
 * - Rejects non-string or missing payloads
 * - Trims leading/trailing whitespace and collapses internal multi-spaces
 * - Rejects control characters
 * - Enforces length between 1 and 120 characters after trimming
 */
export function validateMovieTitle(input: unknown): MovieValidationResult {
  if (typeof input !== "string") {
    return {
      valid: false,
      error: "Movie title must be a valid text string.",
    };
  }

  // Trim surrounding whitespace and collapse consecutive internal whitespace
  const normalized = input.replace(/[\r\n\t]+/g, " ").trim().replace(/\s{2,}/g, " ");

  if (normalized.length < MOVIE_TITLE_MIN_LENGTH) {
    return {
      valid: false,
      error: "Please enter a favorite movie title (cannot be blank).",
    };
  }

  if (normalized.length > MOVIE_TITLE_MAX_LENGTH) {
    return {
      valid: false,
      error: `Movie title must be ${MOVIE_TITLE_MAX_LENGTH} characters or fewer (received ${normalized.length}).`,
    };
  }

  // Disallow ASCII control characters
  if (/[\u0000-\u001F\u007F]/.test(normalized)) {
    return {
      valid: false,
      error: "Movie title contains invalid control characters.",
    };
  }

  return {
    valid: true,
    movie: normalized,
  };
}
