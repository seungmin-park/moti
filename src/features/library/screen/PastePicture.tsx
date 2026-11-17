"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ClipboardEvent } from "react";
import { Check, ClipboardPaste, ImageMinus } from "lucide-react";
import type { ProductResponse } from "../presentation/library-dto";
import {
  PASTE_MAX_EDGE,
  blockedPasteMessage,
  clipboardProblem,
  fitWithin,
  followSave,
  noImageMessage,
  pickPastedImage,
  unreadableMessage,
  uploadPlan,
  type PreviewPhase,
} from "./picture-paste";
import type { DetailNotice, ScreenEvent } from "./screen-state";

async function opened<T>(image: Blob, read: (element: HTMLImageElement) => T | Promise<T>): Promise<T> {
  const url = URL.createObjectURL(image);
  try {
    const element = new Image();
    element.src = url;
    await element.decode();
    return await read(element);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Redraws a picture the browser can open but the route should not get as it is (too large, too many pixels, HEIC,
// TIFF) as a JPEG whose long edge is at most 1600 px. White under transparent pixels, as JPEG has no alpha.
function shrink(image: Blob): Promise<Blob> {
  return opened(image, async (element) => {
    const size = fitWithin({ width: element.naturalWidth, height: element.naturalHeight }, PASTE_MAX_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no canvas");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(element, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("no jpeg");
    return blob;
  });
}

async function prepare(image: Blob): Promise<Blob> {
  if (uploadPlan(image) === "shrink") return shrink(image);
  // A small file can still hold more pixels than the server decodes. Unreadable here, the server says why.
  const size = await opened(image, (element) => ({ width: element.naturalWidth, height: element.naturalHeight })).catch(() => null);
  return uploadPlan(image, size) === "send" ? image : shrink(image);
}

function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files);
  if (files.length > 0) return files;
  return Array.from(data.items).flatMap((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

const unchanging = () => () => {};
const clipboardReadable = () => typeof navigator.clipboard?.read === "function";

async function readClipboardImage(): Promise<Blob | null> {
  for (const item of await navigator.clipboard.read()) {
    const type = pickPastedImage(item.types.map((name) => ({ type: name })))?.type;
    if (type) return item.getType(type);
  }
  return null;
}

// The detail's picture area: a paste target that is editable so iPhone offers 붙여넣기 on a long press, a button for
// browsers that let a page read the clipboard, a preview with 저장 and 취소, and 붙여 넣은 사진 지우기.
export function PastePicture({ product, notice, writing, blocked, send }: {
  product: ProductResponse;
  notice: DetailNotice | null;
  writing: "picture.paste" | "picture.clear" | null;
  blocked: boolean;
  send: (event: ScreenEvent) => void;
}) {
  const id = useId();
  const target = useRef<HTMLDivElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<PreviewPhase<{ image: Blob; url: string }>>({ preview: null, sending: false });
  const [preparing, setPreparing] = useState(false);
  const canRead = useSyncExternalStore(unchanging, clipboardReadable, () => false);
  const saving = writing === "picture.paste";
  const clearing = writing === "picture.clear";
  // Set when the owner saves or clears here, so only that answer moves the focus.
  const asked = useRef(false);
  // Where the focus goes once the preview appears or goes: the element it should land on exists only after the commit.
  const moveFocus = useRef<"save" | "target" | null>(null);
  const pictureNotice = notice?.form === "picture" ? notice : null;
  // The save's answer settles the preview while rendering: a saved one is dropped before the next commit, so the paste
  // target is back, and the old preview can never return when the shown picture changes again (a clear, a collection).
  const followed = followSave(phase, { saving, saved: pictureNotice?.kind === "saved" });
  if (followed !== phase) setPhase(followed);
  const previewing = followed.preview;
  const error = pictureNotice?.kind === "error" ? pictureNotice.message : null;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;

  // Typing, dropping or the system paste would put content into the editable target; it only ever receives pictures.
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const keepEmpty = (event: Event) => event.preventDefault();
    element.addEventListener("beforeinput", keepEmpty);
    element.addEventListener("drop", keepEmpty);
    return () => {
      element.removeEventListener("beforeinput", keepEmpty);
      element.removeEventListener("drop", keepEmpty);
    };
  }, [previewing]);

  useEffect(() => {
    const where = moveFocus.current;
    moveFocus.current = null;
    if (where === "save") saveButton.current?.focus();
    if (where === "target") target.current?.focus();
  }, [previewing]);

  useEffect(() => () => {
    if (previewing) URL.revokeObjectURL(previewing.url);
  }, [previewing]);

  // A saved paste or a clear removes the buttons that were pressed, so the focus goes back to the paste target.
  useEffect(() => {
    if (!pictureNotice || !asked.current) return;
    asked.current = false;
    if (pictureNotice.kind === "saved") target.current?.focus();
  }, [pictureNotice]);

  async function show(image: Blob | null) {
    if (!image) {
      send({ type: "detail.pictureRefused", message: noImageMessage });
      return;
    }
    setPreparing(true);
    try {
      const prepared = await prepare(image);
      setPhase({ preview: { image: prepared, url: URL.createObjectURL(prepared) }, sending: false });
      send({ type: "detail.picturePrepared" });
      moveFocus.current = "save";
    } catch {
      send({ type: "detail.pictureRefused", message: unreadableMessage });
    } finally {
      setPreparing(false);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    if (preparing) return;
    if (blocked) {
      send({ type: "detail.pictureRefused", message: blockedPasteMessage });
      return;
    }
    void show(pickPastedImage(clipboardFiles(event.clipboardData)));
  }

  async function fromClipboard() {
    try {
      await show(await readClipboardImage());
    } catch (problem) {
      send({ type: "detail.pictureRefused", message: clipboardProblem(problem) });
    }
  }

  function cancel() {
    setPhase({ preview: null, sending: false });
    moveFocus.current = "target";
  }

  return (
    <div className="paste-picture" role="group" aria-labelledby={`${id}-label`} aria-busy={saving || clearing || preparing}>
      <span className="paste-picture-label" id={`${id}-label`}>
        사진 붙여넣기
      </span>
      {previewing ? (
        <div className="paste-preview">
          {/* A local object URL of the picture about to be sent; next/image has nothing to optimize here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewing.url} alt="붙여 넣을 사진 미리보기" />
          <div className="paste-actions">
            <button
              ref={saveButton}
              className="button secondary"
              type="button"
              disabled={blocked}
              onClick={() => {
                asked.current = true;
                send({ type: "detail.pastePicture", image: previewing.image });
              }}
            >
              <Check size={16} aria-hidden="true" />
              {saving ? "저장하는 중…" : "사진 저장"}
            </button>
            <button className="text-button" type="button" disabled={saving} onClick={cancel}>
              취소
            </button>
          </div>
        </div>
      ) : (
        <div
          ref={target}
          className="paste-target"
          role="textbox"
          aria-label="사진 붙여넣기"
          aria-describedby={error ? `${helpId} ${errorId}` : helpId}
          aria-invalid={error ? true : undefined}
          contentEditable={!blocked}
          suppressContentEditableWarning
          inputMode="none"
          tabIndex={0}
          spellCheck={false}
          data-placeholder={preparing ? "사진을 준비하는 중…" : "여기를 누르고 붙여 넣기"}
          onPaste={onPaste}
          onInput={(event) => {
            event.currentTarget.textContent = "";
          }}
        />
      )}
      <p className="paste-help" id={helpId}>
        상품 사진을 복사한 뒤 여기에 붙여 넣어요. iPhone은 칸을 길게 눌러 붙여넣기를, PC는 ⌘V나 Ctrl+V를 눌러요.
      </p>
      {error && (
        <p className="form-error" id={errorId} role="alert">
          {error}
        </p>
      )}
      {pictureNotice?.kind === "saved" && (
        <p className="form-success" role="status">
          <Check size={16} aria-hidden="true" />
          {pictureNotice.message}
        </p>
      )}
      <div className="paste-actions">
        {canRead && !previewing && (
          <button className="button secondary" type="button" disabled={blocked || preparing} onClick={() => void fromClipboard()}>
            <ClipboardPaste size={16} aria-hidden="true" />
            클립보드에서 가져오기
          </button>
        )}
        {product.picture?.pasted && !previewing && (
          <button
            className="text-button"
            type="button"
            disabled={blocked}
            onClick={() => {
              asked.current = true;
              send({ type: "detail.clearPicture" });
            }}
          >
            <ImageMinus size={15} aria-hidden="true" />
            {clearing ? "지우는 중…" : "붙여 넣은 사진 지우기"}
          </button>
        )}
      </div>
    </div>
  );
}
