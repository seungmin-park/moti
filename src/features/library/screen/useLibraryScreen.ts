"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createLibraryApi } from "./library-api";
import { initialScreen, perform, pollDelay, transition, type LibraryScreenState, type ScreenEvent } from "./screen-state";

const api = createLibraryApi();
// A new link, retry or restore starts a fresh round of polling with the short intervals again.
const restartsPolling: ReadonlySet<ScreenEvent["type"]> = new Set(["link.settled", "metadata.settled", "restore.settled"]);

function usePageVisible() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function useLibraryScreen() {
  const [state, setState] = useState<LibraryScreenState>(initialScreen.state);
  const [polls, setPolls] = useState(0);
  const latest = useRef<LibraryScreenState>(initialScreen.state);
  const visible = usePageVisible();

  const send = useCallback(function send(event: ScreenEvent) {
    if (event.type === "poll.settled") setPolls((count) => count + 1);
    if (restartsPolling.has(event.type)) setPolls(0);
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

  const delay = pollDelay(state, polls);
  useEffect(() => {
    if (delay === null || !visible) return;
    const timer = window.setTimeout(() => send({ type: "poll" }), delay);
    return () => window.clearTimeout(timer);
  }, [delay, polls, visible, send]);

  useEffect(() => {
    if (state.phase === "leaving") window.location.replace(state.to);
  }, [state]);

  return { state, send };
}
