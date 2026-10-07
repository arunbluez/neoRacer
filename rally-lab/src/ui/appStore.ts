// Low-rate UI state in Zustand. High-rate data (packets, samples, poses)
// stays in core ring buffers and is read by screens on a timer.

import { create } from 'zustand';
import type { PromptRequest, PromptResponse } from '../core/tests/types';

export type Tab = 'connect' | 'monitor' | 'console' | 'drive' | 'tests' | 'camera' | 'data';

export type OpenPrompt = {
  id: number;
  req: PromptRequest;
  taps: { button: string; t: number }[];
  resolve: (r: PromptResponse) => void;
};

type AppState = {
  tab: Tab;
  setTab: (t: Tab) => void;
  prompts: OpenPrompt[];
  addPrompt: (p: OpenPrompt) => void;
  removePrompt: (id: number) => void;
  /** Bumped when lab state (session, profile, settings, runner) changes. */
  version: number;
  bump: () => void;
  toast?: { text: string; kind: 'info' | 'error'; id: number };
  showToast: (text: string, kind?: 'info' | 'error') => void;
  /** Camera frames per second while the camera is on (for the header). */
  camFps?: number;
  setCamFps: (fps: number | undefined) => void;
  updateReady: boolean;
  applyUpdate?: () => void;
  setUpdate: (ready: boolean, apply?: () => void) => void;
};

let toastId = 0;

export const useApp = create<AppState>((set) => ({
  tab: 'connect',
  setTab: (tab) => set({ tab }),
  prompts: [],
  addPrompt: (p) => set((s) => ({ prompts: [...s.prompts, p] })),
  removePrompt: (id) => set((s) => ({ prompts: s.prompts.filter((p) => p.id !== id) })),
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
  showToast: (text, kind = 'info') => {
    const id = ++toastId;
    set({ toast: { text, kind, id } });
    setTimeout(() => set((s) => (s.toast?.id === id ? { toast: undefined } : {})), kind === 'error' ? 5000 : 2500);
  },
  setCamFps: (camFps) => set({ camFps }),
  updateReady: false,
  setUpdate: (updateReady, applyUpdate) => set({ updateReady, applyUpdate }),
}));
