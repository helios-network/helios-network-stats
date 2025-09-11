export interface ValidationResult {
  isValid: boolean;
  error?: string;
}

export interface RateLimitData {
  count: number;
  resetTime: number;
}