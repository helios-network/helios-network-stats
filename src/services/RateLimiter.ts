import express from 'express';
import { RateLimitData } from '../types/validation';
import { config } from '../config/environment';

export class RateLimiter {
  private requestCounts = new Map<string, RateLimitData>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor() {
    // Periodic cleanup of rate limiter to prevent memory leaks
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [ip, data] of this.requestCounts.entries()) {
        if (now > data.resetTime + config.rateLimitWindowMs) { // Extra buffer for cleanup
          this.requestCounts.delete(ip);
        }
      }
      console.debug(`Rate limiter cleanup: ${this.requestCounts.size} active IPs`);
    }, config.rateLimitWindowMs);
  }

  middleware() {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const clientIP = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      
      for (const [ip, data] of this.requestCounts.entries()) {
        if (now > data.resetTime) {
          this.requestCounts.delete(ip);
        }
      }
      
      const clientData = this.requestCounts.get(clientIP);
      if (!clientData) {
        this.requestCounts.set(clientIP, { count: 1, resetTime: now + config.rateLimitWindowMs });
        return next();
      }
      
      if (now > clientData.resetTime) {
        clientData.count = 1;
        clientData.resetTime = now + config.rateLimitWindowMs;
        return next();
      }
      
      if (clientData.count >= config.rateLimitRequests) {
        return res.status(429).json({ 
          error: 'Too many requests. Please try again later.',
          retryAfter: Math.ceil((clientData.resetTime - now) / 1000)
        });
      }
      
      clientData.count++;
      next();
    };
  }

  getStats() {
    return {
      activeIPs: this.requestCounts.size,
      requestCounts: this.requestCounts
    };
  }

  cleanup() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.requestCounts.clear();
  }
}