// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { readFileSync, copyFileSync, mkdirSync, statSync } from "node:fs";
var __electron_vite_injected_dirname = "/home/user/munder-difflin";
var pkg = JSON.parse(readFileSync(resolve(__electron_vite_injected_dirname, "package.json"), "utf-8"));
var define = { __APP_VERSION__: JSON.stringify(pkg.version) };
var defineMain = {
  ...define,
  __POSTHOG_KEY__: JSON.stringify(process.env.POSTHOG_KEY ?? ""),
  __POSTHOG_HOST__: JSON.stringify(process.env.POSTHOG_HOST ?? "https://us.i.posthog.com")
};
function copyMainSidecars() {
  const ASSETS = [
    ["src/main/slack-trigger.cjs", "out/main/slack-trigger.cjs"],
    // Knowledge Graph core: required by knowledge.ts at runtime (pure-JS, no
    // native deps), so it must be emitted next to the main bundle like the
    // Slack sidecar above.
    ["src/main/kg-core.cjs", "out/main/kg-core.cjs"]
  ];
  return {
    name: "copy-main-cjs-sidecars",
    writeBundle() {
      for (const [fromRel, toRel] of ASSETS) {
        const from = resolve(__electron_vite_injected_dirname, fromRel);
        const to = resolve(__electron_vite_injected_dirname, toRel);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        const copied = statSync(to);
        if (!copied.isFile() || copied.size === 0) {
          throw new Error(`Failed to copy main-process sidecar: ${fromRel} -> ${toRel}`);
        }
      }
    }
  };
}
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMainSidecars()],
    define: defineMain,
    build: {
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/main/index.ts") }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define,
    build: {
      rollupOptions: {
        input: { index: resolve(__electron_vite_injected_dirname, "src/preload/index.ts") }
      }
    }
  },
  renderer: {
    define,
    root: resolve(__electron_vite_injected_dirname, "src/renderer"),
    build: {
      rollupOptions: {
        // Two HTML entries: the app, and the Stapler's own windows (the puck
        // and the screenshot overlay), which load stapler.html#<view> through
        // ctx.loadRendererEntry (src/main/features). Both emit to out/renderer.
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html"),
          stapler: resolve(__electron_vite_injected_dirname, "src/renderer/stapler.html")
        }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(__electron_vite_injected_dirname, "src/renderer/src"),
        "@brand": resolve(__electron_vite_injected_dirname, "docs"),
        "@shared": resolve(__electron_vite_injected_dirname, "src/shared")
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
