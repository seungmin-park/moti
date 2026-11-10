"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ProductQuery } from "./model";

const options = [
  { value: "newest", label: "최근 담은 순" },
  { value: "price-low", label: "낮은 가격순" },
  { value: "price-high", label: "높은 가격순" },
] as const;

type MenuState = { open: false } | { open: true; activeIndex: number };

export function SortMenu({
  value,
  onChange,
}: {
  value: ProductQuery["sort"];
  onChange: (value: ProductQuery["sort"]) => void;
}) {
  const [menu, setMenu] = useState<MenuState>({ open: false });
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);

  useEffect(() => {
    if (menu.open) itemRefs.current[menu.activeIndex]?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu.open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target))
        setMenu({ open: false });
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu.open]);

  const closeAndFocusTrigger = () => {
    setMenu({ open: false });
    triggerRef.current?.focus();
  };

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!menu.open) return;
    let nextIndex = menu.activeIndex;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (nextIndex + 1) % options.length;
        break;
      case "ArrowUp":
        nextIndex = (nextIndex + options.length - 1) % options.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = options.length - 1;
        break;
      case "Escape":
        event.preventDefault();
        closeAndFocusTrigger();
        return;
      default:
        return;
    }
    event.preventDefault();
    setMenu({ open: true, activeIndex: nextIndex });
  };

  return (
    <div ref={rootRef} className="sort-menu">
      <button
        ref={triggerRef}
        className="sort-trigger"
        type="button"
        aria-label={`정렬: ${options[selectedIndex].label}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menuId : undefined}
        onPointerDown={(event) => {
          if (menu.open) event.preventDefault();
        }}
        onClick={() => {
          if (menu.open) closeAndFocusTrigger();
          else setMenu({ open: true, activeIndex: selectedIndex });
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setMenu({
              open: true,
              activeIndex: event.key === "ArrowDown" ? 0 : options.length - 1,
            });
          }
        }}
      >
        <span>{options[selectedIndex].label}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {menu.open && (
        <div
          className="sort-options"
          id={menuId}
          role="menu"
          aria-label="정렬"
          onKeyDown={move}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setMenu({ open: false });
          }}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={value === option.value}
              tabIndex={-1}
              onClick={() => {
                onChange(option.value);
                closeAndFocusTrigger();
              }}
            >
              <span>{option.label}</span>
              {value === option.value && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
