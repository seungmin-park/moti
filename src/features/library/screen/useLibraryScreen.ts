"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createLibraryApi } from "./library-api";
import { initialScreen, perform, transition, type LibraryScreenState, type ScreenEvent } from "./screen-state";

const api = createLibraryApi();

export function useLibraryScreen() {
  const [state, setState] = useState<LibraryScreenState>(initialScreen.state);
  const latest = useRef<LibraryScreenState>(initialScreen.state);

  const send = useCallback(function send(event: ScreenEvent) {
    const next = transition(latest.current, event);
    latest.current = next.state;
    setState(next.state);
    if (next.call) void perform(api, next.call).then(send);
  }, []);

  useEffect(() => {
    if (initialScreen.call) void perform(api, initialScreen.call).then(send);
  }, [send]);

  useEffect(() => {
    // A page restored from the back/forward cache still holds the library read before a logout.
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) send({ type: "resume" });
    };
    window.addEventListener("pageshow", resume);
    return () => window.removeEventListener("pageshow", resume);
  }, [send]);

  useEffect(() => {
    if (state.phase === "leaving") window.location.replace(state.to);
  }, [state]);

  return { state, send };
}
