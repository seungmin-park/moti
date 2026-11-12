"use client";

import { Clock, ImageOff, Link2 } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import type { PictureView } from "./product-view";

const icons = { link: Link2, waiting: Clock, off: ImageOff } as const;

// The private copy is reached through the same-origin picture route, which redirects to a short-lived signed link.
// `unoptimized` keeps Next's optimizer from fetching or caching it, and no Referer leaves the page.
export function ProductPicture({ view, sizes, iconSize }: { view: PictureView; sizes: string; iconSize: number }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (view.kind === "photo" && broken !== view.src) {
    return (
      <Image src={view.src} alt={view.alt} fill sizes={sizes} unoptimized referrerPolicy="no-referrer"
        onError={() => setBroken(view.src)} />
    );
  }
  const { icon, text } = view.kind === "placeholder" ? view : { icon: "off" as const, text: "사진을 불러오지 못했어요" };
  const Icon = icons[icon];
  return (
    <div className="picture-placeholder">
      <Icon size={iconSize} aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}
