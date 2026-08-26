import type { ComponentType } from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Navigate, RouterProvider, createBrowserRouter } from "react-router-dom";

import { Shell } from "./components/layout/Shell";
import "./index.css";
import { DEFAULT_PATH, NAV } from "./lib/nav";
import { Actions } from "./pages/Actions";
import { Data } from "./pages/Data";
import { Operate } from "./pages/Operate";
import { Plan } from "./pages/Plan";
import { Radar } from "./pages/Radar";
import { Review } from "./pages/Review";
import { Risk } from "./pages/Risk";
import { Sectors } from "./pages/Sectors";
import { Signals } from "./pages/Signals";
import { StockData } from "./pages/StockData";
import { Today } from "./pages/Today";

/**
 * 路径 → 组件。**键必须与 lib/nav.ts 的 path 一一对应** ——
 * 下面那句检查会在启动时立刻炸出漏配,而不是等用户点进去看白屏(那种失效没人会发现)。
 */
const PAGES: Record<string, ComponentType> = {
  "/today": Today,
  "/review": Review,
  "/sectors": Sectors,
  "/stock": StockData,
  "/radar": Radar,
  "/signals": Signals,
  "/operate": Operate,
  "/plan": Plan,
  "/risk": Risk,
  "/actions": Actions,
  "/data": Data,
};

const missing = NAV.filter((n) => !PAGES[n.path]).map((n) => n.path);
if (missing.length) throw new Error(`导航有项没有对应页面:${missing.join(", ")}`);

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Navigate to={DEFAULT_PATH} replace /> },
      ...NAV.map((n) => {
        const C = PAGES[n.path]!;
        return { path: n.path, element: <C /> };
      }),
      { path: "*", element: <Navigate to={DEFAULT_PATH} replace /> },
    ],
  },
]);

const root = document.getElementById("root");
if (!root) throw new Error("找不到 #root");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
