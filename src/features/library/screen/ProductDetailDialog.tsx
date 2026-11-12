"use client";

import { ArrowUpRight, Check, CheckCheck, CircleAlert, Clock, Link2, LoaderCircle, RotateCcw } from "lucide-react";
import { Dialog } from "../../wishlist/Dialog";
import type { CollectionResponse, ProductResponse } from "../presentation/library-dto";
import { toProductDetailView } from "./product-view";

export function ProductDetailDialog({
  product,
  collections,
  arrival,
  retrying,
  error,
  onRetry,
  onClose,
}: {
  product: ProductResponse;
  collections: CollectionResponse[];
  arrival: "added" | "duplicate" | null;
  retrying: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  const view = toProductDetailView(product, collections, arrival);
  const phase = product.metadata.phase;
  return (
    <Dialog title="담아둔 물건" wide onClose={onClose}>
      {view.arrival && (
        <p className="duplicate-notice" role="status">
          <CheckCheck size={18} aria-hidden="true" />
          {view.arrival}
        </p>
      )}
      <div className="detail-body">
        <div className="detail-visual">
          <div className="detail-picture">
            <div className="picture-placeholder">
              <Link2 size={40} aria-hidden="true" />
              <span>원본 링크를 보관했어요</span>
            </div>
          </div>
          {view.openUrl && (
            <a className="button secondary original-link" href={view.openUrl} target="_blank" rel="noopener noreferrer">
              원본 링크 열기 <ArrowUpRight size={17} aria-hidden="true" />
            </a>
          )}
          <p className="source-url">{view.sourceUrl}</p>
        </div>
        <div className="detail-info">
          <span className="shop-name">{view.shop}</span>
          <h3>{view.title}</h3>
          <p className="detail-option">{view.option}</p>
          <div className="detail-price">
            <strong>{view.price.value}</strong>
            {view.price.checked && <p>{view.price.checked}</p>}
          </div>
          <div className={`metadata-status ${view.canRetry ? "failed" : phase}`}>
            {view.canRetry ? (
              <CircleAlert size={20} aria-hidden="true" />
            ) : phase === "ready" ? (
              <Check size={20} aria-hidden="true" />
            ) : phase === "queued" ? (
              <Clock size={20} aria-hidden="true" />
            ) : (
              <LoaderCircle size={20} aria-hidden="true" />
            )}
            <div>
              <strong>{view.status.title}</strong>
              <p>{view.status.detail}</p>
            </div>
          </div>
          {view.canRetry && (
            <button className="text-button retry-button" type="button" disabled={retrying} onClick={onRetry}>
              <RotateCcw size={15} aria-hidden="true" />
              {retrying ? "다시 가져오는 중" : "다시 가져오기"}
            </button>
          )}
          {error && (
            <p className="form-error retry-error" role="alert">
              {error}
            </p>
          )}
          <dl className="detail-facts">
            <div>
              <dt>컬렉션</dt>
              <dd>{view.collectionNames.length > 0 ? view.collectionNames.join(", ") : "아직 분류하지 않았어요"}</dd>
            </div>
            <div>
              <dt>담은 날</dt>
              <dd>{view.addedOn}</dd>
            </div>
            {view.purchased && (
              <div>
                <dt>상태</dt>
                <dd>구매완료</dd>
              </div>
            )}
            {view.note && (
              <div>
                <dt>메모</dt>
                <dd className="detail-note">{view.note}</dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </Dialog>
  );
}
