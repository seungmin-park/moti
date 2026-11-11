"use client";

import { useId } from "react";
import { ArrowUpRight, CircleAlert, Link2, LoaderCircle } from "lucide-react";
import { CollectionPicker } from "../../wishlist/CollectionPicker";
import { Dialog } from "../../wishlist/Dialog";
import type { CollectionResponse } from "../presentation/library-dto";
import type { FieldName } from "./library-api";
import type { FormError, LinkDraft, ScreenEvent } from "./screen-state";

export function FieldError({ id, error, field }: { id: string; error: FormError | null; field: FieldName | null }) {
  if (!error || error.field !== field) return null;
  return (
    <p className="form-error" role="alert" id={id}>
      <CircleAlert size={16} aria-hidden="true" />
      {error.message}
    </p>
  );
}

export function fieldProps(error: FormError | null, field: FieldName, id: string) {
  const invalid = error?.field === field;
  return { "aria-invalid": invalid || undefined, "aria-describedby": invalid ? id : undefined };
}

export function AddLinkDialog({
  draft,
  saving,
  creating,
  error,
  collections,
  send,
}: {
  draft: LinkDraft;
  saving: boolean;
  creating: string | null;
  error: FormError | null;
  collections: CollectionResponse[];
  send: (event: ScreenEvent) => void;
}) {
  const id = useId();
  const errorId = (field: FieldName | null) => `${id}-${field ?? "form"}-error`;
  return (
    <Dialog title="마음에 든 물건을 담아두세요" onClose={() => send({ type: "dialog.close" })}>
      <p className="dialog-intro">쇼핑하다 발견한 상품 링크 하나면 충분해요.</p>
      <form
        noValidate
        aria-busy={saving}
        onSubmit={(event) => {
          event.preventDefault();
          send({ type: "add.submit" });
        }}
      >
        <label className="field">
          <span>상품 링크</span>
          <div className="input-icon">
            <Link2 size={18} aria-hidden="true" />
            <input
              autoFocus
              type="url"
              inputMode="url"
              placeholder="https://shop.com/product"
              value={draft.url}
              readOnly={saving}
              onChange={(event) => send({ type: "add.edit", url: event.target.value })}
              {...fieldProps(error, "url", errorId("url"))}
            />
          </div>
        </label>
        <FieldError id={errorId("url")} error={error} field="url" />
        <label className="field">
          <span>
            옵션 <small>선택</small>
          </span>
          <input
            placeholder="예: 크림 · 250mm"
            value={draft.option}
            readOnly={saving}
            onChange={(event) => send({ type: "add.edit", option: event.target.value })}
            {...fieldProps(error, "option", errorId("option"))}
          />
        </label>
        <FieldError id={errorId("option")} error={error} field="option" />
        <p className="field-help">다른 색상이나 사이즈는 따로 담아둘 수 있어요.</p>
        <CollectionPicker
          collections={collections}
          selectedIds={draft.collectionIds}
          onToggle={(collectionId) => send({ type: "add.toggle", collectionId })}
          onCreate={(name) => send({ type: "add.createCollection", name })}
        />
        {creating !== null && (
          <p className="form-success" role="status">
            <LoaderCircle size={16} aria-hidden="true" />“{creating}” 만드는 중…
          </p>
        )}
        <FieldError id={errorId("collection")} error={error} field="collection" />
        <FieldError id={errorId(null)} error={error} field={null} />
        <button className="button primary full" type="submit" disabled={saving || creating !== null}>
          {saving ? "담는 중…" : "위시에 담기"} <ArrowUpRight size={17} aria-hidden="true" />
        </button>
      </form>
    </Dialog>
  );
}
