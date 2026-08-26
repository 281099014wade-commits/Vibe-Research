import { create } from "zustand";

export type Theme = "dark" | "light";

const THEME_KEY = "vra-theme"; // 🔴 与 index.html 首帧脚本同一把钥匙,改这里要一起改

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* 隐私模式下写不进去 —— 本次会话仍然生效,不值得打断用户 */
  }
}

export interface ChatTurn {
  id: number;
  role: "user" | "agent";
  text: string;
  /** agent 回合可带来源提示;没有就是没有,不编 */
  note?: string;
}

interface UiState {
  theme: Theme;
  toggleTheme: () => void;

  /** 底部 Agent 对话区是否展开 */
  dockOpen: boolean;
  /** 打开时可带一句预填问题(从页面某张卡"就这个问 Agent"点进来) */
  dockSeed: string;
  openDock: (seed?: string) => void;
  closeDock: () => void;
  toggleDock: () => void;

  turns: ChatTurn[];
  pushTurn: (t: Omit<ChatTurn, "id">) => void;
}

export const useUi = create<UiState>((set, get) => ({
  theme: readTheme(),
  toggleTheme: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    applyTheme(next);
    set({ theme: next });
  },

  dockOpen: false,
  dockSeed: "",
  openDock: (seed = "") => set({ dockOpen: true, dockSeed: seed }),
  closeDock: () => set({ dockOpen: false }),
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen, dockSeed: s.dockOpen ? "" : s.dockSeed })),

  turns: [],
  pushTurn: (t) => set((s) => ({ turns: [...s.turns, { ...t, id: s.turns.length + 1 }] })),
}));

/** 启动时把已读到的主题落到 <html>,保证 store 与 DOM 从第一帧就一致 */
applyTheme(readTheme());
