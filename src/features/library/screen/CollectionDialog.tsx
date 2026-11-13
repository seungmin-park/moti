"use client";

import { useId } from "react";
import { Dialog } from "../../wishlist/Dialog";
import { FieldError, fieldProps } from "./AddLinkDialog";
import type { FormError, ScreenEvent } from "./screen-state";

export function CollectionDialog({
  renaming,
  name,
  saving,
  refreshing,
  error,
  send,
}: {
  renaming: boolean;
  name: string;
  saving: boolean;
  refreshing: boolean;
  error: FormError | null;
  send: (event: ScreenEvent) => void;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <Dialog title={renaming ? "컬렉션 이름 바꾸기" : "새로운 컬렉션"} onClose={() => send({ type: "dialog.close" })}>
      <p className="dialog-intro">함께 두고 싶은 물건들에 이름을 붙여주세요.</p>
      <form
        noValidate
        aria-busy={saving}
        onSubmit={(event) => {
          event.preventDefault();
          send({ type: "collection.submit" });
        }}
      >
        <label className="field">
          <span>컬렉션 이름</span>
          <input
            autoFocus
            placeholder="예: 오래 머물고 싶은 방"
            value={name}
            readOnly={saving}
            onChange={(event) => send({ type: "collection.edit", name: event.target.value })}
            {...fieldProps(error, "collection", errorId)}
          />
        </label>
        <FieldError id={errorId} error={error} field="collection" />
        <FieldError id={`${id}-form-error`} error={error} field={null} />
        <button className="button primary full" type="submit" disabled={saving || refreshing}>
          {renaming ? (saving ? "저장하는 중…" : "이름 저장") : saving ? "만드는 중…" : "만들기"}
        </button>
      </form>
    </Dialog>
  );
}
