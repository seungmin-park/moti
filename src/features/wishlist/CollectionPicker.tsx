"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Plus, Search } from "lucide-react";
import type { Collection } from "./model";

export function CollectionPicker({
  collections,
  selectedIds,
  onToggle,
  onCreate,
}: {
  collections: Collection[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const labelId = useId();
  const name = query.trim().normalize("NFC");
  const normalized = name.toLocaleLowerCase();
  const matches = collections.filter((collection) =>
    collection.name.toLocaleLowerCase().includes(normalized),
  );
  const exists = collections.some((collection) =>
    collection.name.toLocaleLowerCase() === normalized,
  );
  const canCreate = name.length > 0 && name.length <= 40 && !exists;
  const selected = collections.filter((collection) => selectedIds.includes(collection.id));
  const summary = selected.length === 0
    ? "컬렉션 선택"
    : `${selected[0].name}${selected.length > 1 ? ` 외 ${selected.length - 1}개` : ""}`;

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const dismiss = (event: Event) => {
      if (rootRef.current && !event.composedPath().includes(rootRef.current))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("click", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const create = () => {
    if (!canCreate) return;
    onCreate(name);
    searchRef.current?.focus();
  };

  return (
    <div className="collection-picker" ref={rootRef}>
      <p className="collection-picker-label" id={labelId}>
        담을 컬렉션 <small>선택 · 여러 개 가능</small>
      </p>
      <button
        ref={triggerRef}
        className="collection-picker-trigger"
        type="button"
        aria-label={`담을 컬렉션: ${summary}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{summary}</span>
        <ChevronDown size={17} aria-hidden="true" />
      </button>
      {open && (
        <div className="collection-picker-panel" id={panelId} role="group" aria-labelledby={labelId}>
          <label className="collection-picker-search">
            <Search size={17} aria-hidden="true" />
            <input
              ref={searchRef}
              aria-label="컬렉션 검색 또는 새 이름"
              placeholder="컬렉션을 찾거나 새 이름 입력"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key !== "Enter") return;
                event.preventDefault();
                create();
              }}
            />
          </label>
          <div className="collection-picker-options" role="group" aria-label="컬렉션 목록">
            {matches.map((collection) => (
              <label key={collection.id}>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(collection.id)}
                  onChange={() => onToggle(collection.id)}
                />
                <span>{collection.name}</span>
              </label>
            ))}
            {matches.length === 0 && <p className="collection-picker-empty">일치하는 컬렉션이 없어요.</p>}
          </div>
          {canCreate && (
            <button
              className="collection-picker-create"
              type="button"
              aria-label={`${name} 컬렉션 만들고 선택`}
              onClick={create}
            >
              <Plus size={17} aria-hidden="true" />
              <span>“{name}” 만들고 선택</span>
            </button>
          )}
          <p className={`collection-picker-hint ${name.length > 40 ? "form-error" : ""}`} role="status">
            {name.length > 40
              ? "컬렉션 이름은 1~40자로 입력해 주세요."
              : selected.length > 0
                ? `${selected.length}개 선택했어요. 이름을 입력하면 새로 만들 수 있어요.`
                : "이름을 입력하면 새 컬렉션을 만들 수 있어요."}
          </p>
        </div>
      )}
      <p className="collection-help">고르지 않으면 위시리스트에만 담아요.</p>
    </div>
  );
}
