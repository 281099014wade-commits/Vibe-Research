import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Navigate, RouterProvider, createBrowserRouter } from "react-router-dom";

import { Shell } from "./core/layout/Shell";
import { registerVerticalUi } from "./core/lib/ui";
import "./index.css";
import { FINANCE_UI } from "./verticals/finance/lib/nav";

/**
 * **组装根**:唯一一处把垂类接进 Core 的地方。
 *
 * 🔴 依赖方向是单向的:垂类 → Core,永不反向。Core 的外壳(Shell / 通用组件)
 *    不认识任何一个具体栏目,换个行业只要换这一行注册。
 * ⚠️ 注册时会**双向查**导航与页面(有导航没页面 / 有页面没导航都当场炸)——
 *    不能等用户点进去看白屏,那种失效没人会发现。
 */
registerVerticalUi(FINANCE_UI);
// 标签页标题跟注册进来的品牌走 —— index.html 里那个是占位,不是真相
document.title = FINANCE_UI.brand;

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <Navigate to={FINANCE_UI.defaultPath} replace /> },
      ...FINANCE_UI.nav.map((n) => {
        const C = FINANCE_UI.pages[n.path]!;
        return { path: n.path, element: <C /> };
      }),
      // 详情路由:有页面但不进导航(注册期已校验它们必须带参数段)
      ...Object.entries(FINANCE_UI.detailRoutes ?? {}).map(([path, C]) => ({ path, element: <C /> })),
      { path: "*", element: <Navigate to={FINANCE_UI.defaultPath} replace /> },
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
