import { useSyncExternalStore } from "react";

const media = window.matchMedia("(max-width: 900px)");
const subscribe = (notify: () => void) => {
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
export function useCompactLayout() {
  return useSyncExternalStore(
    subscribe,
    () => media.matches,
    () => false,
  );
}
