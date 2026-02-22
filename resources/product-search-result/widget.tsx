import { McpUseProvider, useWidget, type WidgetMetadata } from "mcp-use/react";
import React from "react";
import { propSchema, type DashboardWidgetProps } from "./types";
import dashboardHtml from "./dashboard.html?raw";

export const widgetMetadata: WidgetMetadata = {
  description: "ultracontext dashboard UI",
  props: propSchema,
  exposeAsTool: false,
  metadata: {
    prefersBorder: false,
    invoked: "Dashboard ready",
    csp: {
      resourceDomains: ["https://esm.sh"],
    },
  },
};

const ProductSearchResult: React.FC = () => {
  const { props, displayMode, requestDisplayMode, state, setState } =
    useWidget<DashboardWidgetProps, { playheadMs?: number }>();
  const hasAutoRequestedFullscreen = React.useRef(false);
  const disableAutoFullscreen = React.useRef(false);
  const previousDisplayMode = React.useRef(displayMode);
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const initialPlayheadRef = React.useRef<number | null>(null);
  const lastSavedPlayheadRef = React.useRef(state?.playheadMs ?? 0);

  const isInline = displayMode === "inline";
  const zoomScale = 0.78;
  const zoomPercent = `${(1 / zoomScale) * 100}%`;
  const containerClass = isInline
    ? "relative w-full h-[820px] min-h-[820px] overflow-hidden bg-black"
    : "relative w-full h-screen min-h-[760px] overflow-hidden bg-black";
  const handleOpenFullscreen = () => {
    disableAutoFullscreen.current = false;
    requestDisplayMode("fullscreen");
  };
  const handleReturnInline = () => {
    disableAutoFullscreen.current = true;
    requestDisplayMode("inline");
  };
  if (initialPlayheadRef.current === null) {
    initialPlayheadRef.current = state?.playheadMs ?? 0;
  }
  const initialPlayheadMs = Math.max(0, Math.floor(initialPlayheadRef.current));

  const dashboardDoc = React.useMemo(() => {
    const themesJson = JSON.stringify(props?.themes ?? []).replace(/</g, "\\u003c");
    const focusEngineersJson = JSON.stringify(props?.focusEngineers ?? []).replace(/</g, "\\u003c");
    const injected = `<script>window.__UC_INITIAL_PLAYHEAD_MS=${initialPlayheadMs};window.__UC_THEMES=${themesJson};window.__UC_FOCUS_ENGINEERS=${focusEngineersJson};</script>`;
    return dashboardHtml.replace(
      '<script type="module">',
      `${injected}\n  <script type="module">`
    );
  }, [initialPlayheadMs, props?.themes, props?.focusEngineers]);

  React.useEffect(() => {
    if (
      previousDisplayMode.current !== "inline" &&
      displayMode === "inline"
    ) {
      // User returned from fullscreen/pip to inline; don't auto-bounce back.
      disableAutoFullscreen.current = true;
    }
    previousDisplayMode.current = displayMode;
  }, [displayMode]);

  React.useEffect(() => {
    if (
      displayMode === "inline" &&
      !hasAutoRequestedFullscreen.current &&
      !disableAutoFullscreen.current
    ) {
      hasAutoRequestedFullscreen.current = true;
      requestDisplayMode("fullscreen");
    }
  }, [displayMode, requestDisplayMode]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as {
        type?: string;
        ms?: number;
      } | undefined;
      if (!data) return;

      if (data.type !== "uc-dashboard-playhead") return;
      const ms = data.ms;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
      if (ms - lastSavedPlayheadRef.current < 800) return;
      lastSavedPlayheadRef.current = ms;
      setState({ playheadMs: Math.floor(ms) });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [setState]);

  return (
    <McpUseProvider autoSize={isInline}>
      <div className={containerClass}>
        <div
          className={isInline ? "origin-top-left" : "w-full h-full"}
          style={
            isInline
              ? {
                  transform: `scale(${zoomScale})`,
                  width: zoomPercent,
                  height: zoomPercent,
                }
              : undefined
          }
        >
          <iframe
            ref={iframeRef}
            title={props?.title ?? "ultracontext dashboard"}
            srcDoc={dashboardDoc}
            className="block w-full h-full border-0"
            scrolling="no"
          />
        </div>
        <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
          {isInline ? (
            <button
              onClick={handleOpenFullscreen}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs bg-white/90 text-black cursor-pointer"
              title="Open fullscreen"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
                <path
                  d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Fullscreen
            </button>
          ) : (
            <button
              onClick={handleReturnInline}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs bg-white/90 text-black cursor-pointer"
              title="Return to inline"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none">
                <path
                  d="M18 6L6 18M6 6l12 12"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              Inline
            </button>
          )}
        </div>
      </div>
    </McpUseProvider>
  );
};

export default ProductSearchResult;
