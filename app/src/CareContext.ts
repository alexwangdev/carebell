import { createContext, useContext } from 'react';

export interface CareValue {
  state: any;
  token: string;
  call: (path: string, options?: RequestInit) => Promise<any>;
  signIn: (path: string, account: { name: string; email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  view: string;
  setView: (next: string) => void;
  fontSize: number;
}

export const CareContext = createContext<CareValue | null>(null);

export function useCare(): CareValue {
  const value = useContext(CareContext);
  if (!value) throw new Error('CareBell screen used outside the app.');
  return value;
}
