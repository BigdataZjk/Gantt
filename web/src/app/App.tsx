import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { NoticeProvider } from "../ui/Notice";
import { P0DeliveryConfirmationProvider } from "../ui/P0DeliveryConfirmation";
import { TooltipHost } from "../ui/TooltipHost";
import { Root } from "./Root";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function App() {
  useEffect(() => {
    const contextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), a[href]')) event.preventDefault();
    };
    window.addEventListener("contextmenu", contextMenu);
    return () => window.removeEventListener("contextmenu", contextMenu);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <NoticeProvider>
        <TooltipHost />
        <P0DeliveryConfirmationProvider>
          <Root />
        </P0DeliveryConfirmationProvider>
      </NoticeProvider>
    </QueryClientProvider>
  );
}
