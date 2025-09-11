import { ValidationResult } from '../types/validation';

export function validateNodeName(name: any): ValidationResult {
  if (typeof name !== 'string') {
    return { isValid: false, error: 'Name must be a string' };
  }
  if (name.length === 0 || name.length > 50) {
    return { isValid: false, error: 'Name must be between 1 and 50 characters' };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return { isValid: false, error: 'Name contains invalid characters. Only alphanumeric, dots, underscores and hyphens allowed' };
  }
  return { isValid: true };
}

export function validateHost(host: any): ValidationResult {
  if (typeof host !== 'string') {
    return { isValid: false, error: 'Host must be a string' };
  }
  if (host.length === 0 || host.length > 253) {
    return { isValid: false, error: 'Host must be between 1 and 253 characters' };
  }
  // Basic hostname/IP validation
  const hostnameRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  
  if (!hostnameRegex.test(host) && !ipRegex.test(host)) {
    return { isValid: false, error: 'Invalid hostname or IP address format' };
  }
  return { isValid: true };
}

export function validatePort(port: any): ValidationResult {
  const numPort = Number(port);
  if (!Number.isInteger(numPort)) {
    return { isValid: false, error: 'Port must be an integer' };
  }
  if (numPort < 1 || numPort > 65535) {
    return { isValid: false, error: 'Port must be between 1 and 65535' };
  }
  return { isValid: true };
}

export function validateWebSocketUrl(wsUrl: any): ValidationResult {
  if (typeof wsUrl !== 'string') {
    return { isValid: false, error: 'WebSocket URL must be a string' };
  }
  if (wsUrl.length === 0 || wsUrl.length > 500) {
    return { isValid: false, error: 'WebSocket URL must be between 1 and 500 characters' };
  }
  
  try {
    const url = new URL(wsUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return { isValid: false, error: 'WebSocket URL must use ws:// or wss:// protocol' };
    }
    // Block localhost and private IPs for security
    const hostname = url.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return { isValid: false, error: 'Localhost connections not allowed' };
    }
    // Block private IP ranges
    if (/^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(hostname)) {
      return { isValid: false, error: 'Private IP addresses not allowed' };
    }
    // Block other problematic ranges
    if (/^(169\.254\.|224\.|240\.)/.test(hostname)) {
      return { isValid: false, error: 'Invalid IP address range' };
    }
    // Ensure port is reasonable for WebSocket
    const port = url.port ? parseInt(url.port, 10) : (url.protocol === 'wss:' ? 443 : 80);
    if (port < 1 || port > 65535) {
      return { isValid: false, error: 'Invalid port number' };
    }
  } catch (error) {
    return { isValid: false, error: 'Invalid WebSocket URL format' };
  }
  
  return { isValid: true };
}