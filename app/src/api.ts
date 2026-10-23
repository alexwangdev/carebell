import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SESSION_KEY = 'carebell-session';

export const API_BASE = process.env.EXPO_PUBLIC_API_URL
  || (Platform.OS === 'android' ? 'http://10.0.2.2:3780' : 'http://localhost:3780');

export async function loadToken(): Promise<string | null> {
  return AsyncStorage.getItem(SESSION_KEY);
}

export async function saveToken(token: string): Promise<void> {
  if (token) await AsyncStorage.setItem(SESSION_KEY, token);
  else await AsyncStorage.removeItem(SESSION_KEY);
}

export function mediaUrl(path: string): string {
  if (!path) return '';
  if (/^https?:/i.test(path)) return path;
  return `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function request(path: string, options: RequestInit = {}, token?: string | null): Promise<any> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (typeof options.body === 'string' && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });
  } catch {
    throw new ApiError('CareBell could not reach the server. Start it, then try again.', 0);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(body.error || 'That did not finish. Please try again.', response.status);
  }
  return body;
}
